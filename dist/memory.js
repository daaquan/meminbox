import { chunkMarkdown } from "./chunk.js";
import { embedBatch, embedText } from "./embeddings.js";
/** pgvector accepts the "[1,2,3]" text literal; use it for inserts and RPC. */
function toVectorLiteral(vec) {
    return `[${vec.join(",")}]`;
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * Combine keyword and vector evidence for one document. Probabilistic OR:
 * a second retrieval path can only RAISE the score, never drag it below
 * what either path found alone.
 */
export function combineScores(keyword, vector) {
    const k = Math.min(1, Math.max(0, keyword ?? 0));
    const v = Math.min(1, Math.max(0, vector ?? 0));
    return 1 - (1 - k) * (1 - v);
}
const REINDEX_PAGE = 500;
export class MemoryService {
    cfg;
    db;
    constructor(cfg, db) {
        this.cfg = cfg;
        this.db = db;
    }
    // -- projects -------------------------------------------------------------
    async ensureProject(slug, name) {
        const { data, error } = await this.db
            .from("meminbox_projects")
            .upsert({ slug, name: name ?? slug }, { onConflict: "slug" })
            .select("id")
            .single();
        if (error)
            throw new Error(`ensureProject failed: ${error.message}`);
        return data.id;
    }
    /** Look a project up WITHOUT creating it (reads must not create namespaces). */
    async findProjectId(slug) {
        const { data, error } = await this.db
            .from("meminbox_projects")
            .select("id")
            .eq("slug", slug)
            .maybeSingle();
        if (error)
            throw new Error(`findProject failed: ${error.message}`);
        return data?.id ?? null;
    }
    async listProjects() {
        const { data, error } = await this.db
            .from("meminbox_projects")
            .select("slug, name")
            .order("slug");
        if (error)
            throw new Error(`listProjects failed: ${error.message}`);
        return data ?? [];
    }
    // -- writes ---------------------------------------------------------------
    /**
     * Write a memory document. Default status is "inbox": agent writes are
     * NOT trusted memory until promoted. That staging step is the guardrail
     * against one agent's mistake becoming every agent's fact.
     *
     * Once the row is inserted the write has happened: a failure while
     * building the derived index (e.g. the embedding API is down) is
     * reported on the result and in the audit log, never thrown — throwing
     * would make callers retry and store the document twice. `meminbox
     * reindex` repairs the index later.
     */
    async writeDocument(input) {
        const projectId = await this.ensureProject(input.projectSlug ?? this.cfg.defaultProject);
        const provenance = {
            agent: this.cfg.actor,
            source: "manual",
            ...input.provenance,
        };
        const { data, error } = await this.db
            .from("meminbox_documents")
            .insert({
            project_id: projectId,
            title: input.title,
            content_md: input.contentMd,
            status: input.status ?? "inbox",
            source_agent: provenance.agent ?? null,
            provenance,
        })
            .select("*")
            .single();
        if (error)
            throw new Error(`writeDocument failed: ${error.message}`);
        const doc = data;
        let indexError;
        try {
            await this.indexDocument(doc);
        }
        catch (err) {
            indexError = errorMessage(err);
            console.error(`meminbox: saved "${doc.title}" (${doc.id}) but could not index it for vector search: ${indexError}. Run \`meminbox reindex\` later.`);
        }
        await this.audit("write", doc.id, {
            status: doc.status,
            ...(indexError ? { indexError } : {}),
        });
        return indexError ? { ...doc, indexError } : doc;
    }
    async setStatus(id, status) {
        const { data, error } = await this.db
            .from("meminbox_documents")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", id)
            .select("*")
            .maybeSingle();
        if (error)
            throw new Error(`setStatus failed: ${error.message}`);
        if (!data)
            throw new Error(`No memory document with id ${id}`);
        await this.audit(status === "active" ? "promote" : status === "archived" ? "archive" : "demote", id, { status });
        return data;
    }
    async getDocument(id) {
        const { data, error } = await this.db
            .from("meminbox_documents")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error)
            throw new Error(`getDocument failed: ${error.message}`);
        return data ?? null;
    }
    async listDocuments(opts = {}) {
        let projectId = null;
        if (opts.projectSlug) {
            projectId = await this.findProjectId(opts.projectSlug);
            if (!projectId)
                return [];
        }
        let q = this.db
            .from("meminbox_documents")
            .select("*")
            .order("updated_at", { ascending: false })
            .limit(opts.limit ?? 50);
        if (opts.status)
            q = q.eq("status", opts.status);
        if (projectId)
            q = q.eq("project_id", projectId);
        const { data, error } = await q;
        if (error)
            throw new Error(`listDocuments failed: ${error.message}`);
        return (data ?? []);
    }
    // -- derived index ----------------------------------------------------------
    /** Rebuild the chunk/embedding index for one document. Safe to re-run. */
    async indexDocument(doc) {
        const chunks = chunkMarkdown(`${doc.title}\n\n${doc.content_md}`);
        const embeddings = await embedBatch(this.cfg, chunks);
        const { error: delError } = await this.db
            .from("meminbox_document_chunks")
            .delete()
            .eq("document_id", doc.id);
        if (delError)
            throw new Error(`indexDocument delete failed: ${delError.message}`);
        if (chunks.length === 0)
            return;
        const rows = chunks.map((content, i) => ({
            document_id: doc.id,
            chunk_index: i,
            content,
            embedding: embeddings[i] ? toVectorLiteral(embeddings[i]) : null,
        }));
        const { error } = await this.db.from("meminbox_document_chunks").insert(rows);
        if (error)
            throw new Error(`indexDocument insert failed: ${error.message}`);
    }
    /**
     * Rebuild the derived index for EVERY document (paged by id, so no
     * library size is silently truncated). The index is disposable.
     */
    async reindexAll() {
        let total = 0;
        for (let from = 0;; from += REINDEX_PAGE) {
            const { data, error } = await this.db
                .from("meminbox_documents")
                .select("id, title, content_md")
                .order("id")
                .range(from, from + REINDEX_PAGE - 1);
            if (error)
                throw new Error(`reindex listing failed: ${error.message}`);
            const docs = (data ?? []);
            for (const doc of docs)
                await this.indexDocument(doc);
            total += docs.length;
            if (docs.length < REINDEX_PAGE)
                break;
        }
        await this.audit("reindex", null, { documents: total });
        return total;
    }
    // -- search ---------------------------------------------------------------
    /**
     * Hybrid search: keyword (FTS + substring fallback in SQL) merged with
     * vector similarity when embeddings are configured. Keyword-only is a
     * fully supported mode — for a personal-scale memory it is often enough —
     * so a failing embedding API degrades search to keyword-only instead of
     * failing it.
     */
    async search(query, opts = {}) {
        const limit = opts.limit ?? 10;
        const status = opts.status ?? "active";
        let projectId = null;
        if (opts.projectSlug) {
            projectId = await this.findProjectId(opts.projectSlug);
            if (!projectId)
                return [];
        }
        const byDoc = new Map();
        // Keyword path
        const { data: kw, error: kwError } = await this.db.rpc("meminbox_search_documents", {
            p_query: query,
            p_limit: limit * 3,
            p_status: status,
            p_project_id: projectId,
        });
        if (kwError)
            throw new Error(`search (keyword) failed: ${kwError.message}`);
        const kwRows = (kw ?? []);
        const maxRank = Math.max(...kwRows.map((r) => r.rank), 0);
        for (const row of kwRows) {
            byDoc.set(row.id, {
                documentId: row.id,
                title: row.title,
                snippet: row.content_md.slice(0, 300),
                // substring-only matches have rank 0; they still matched the query
                kw: maxRank > 0 ? Math.max(row.rank / maxRank, 0.3) : 0.5,
            });
        }
        // Vector path (only when an embedding provider is configured)
        let queryVec = null;
        try {
            queryVec = await embedText(this.cfg, query);
        }
        catch (err) {
            console.error(`meminbox: vector search skipped, using keyword results only: ${errorMessage(err)}`);
        }
        if (queryVec) {
            const { data: vec, error: vecError } = await this.db.rpc("meminbox_match_chunks", {
                p_embedding: toVectorLiteral(queryVec),
                p_limit: limit * 3,
                p_status: status,
                p_project_id: projectId,
            });
            if (vecError)
                throw new Error(`search (vector) failed: ${vecError.message}`);
            const vecRows = (vec ?? []);
            for (const row of vecRows) {
                const acc = byDoc.get(row.document_id);
                // Rows arrive best-first; a document's later chunks add nothing.
                if (acc?.vec !== undefined)
                    continue;
                if (acc) {
                    acc.vec = row.similarity;
                    if (row.chunk.length > 0)
                        acc.snippet = row.chunk.slice(0, 300);
                }
                else {
                    byDoc.set(row.document_id, {
                        documentId: row.document_id,
                        title: row.title,
                        snippet: row.chunk.slice(0, 300),
                        vec: row.similarity,
                    });
                }
            }
        }
        return [...byDoc.values()]
            .map((a) => ({
            documentId: a.documentId,
            title: a.title,
            snippet: a.snippet,
            score: combineScores(a.kw, a.vec),
            via: [
                ...(a.kw !== undefined ? ["keyword"] : []),
                ...(a.vec !== undefined ? ["vector"] : []),
            ],
        }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
    // -- audit ------------------------------------------------------------------
    async audit(action, documentId, metadata) {
        const { error } = await this.db.from("meminbox_audit_log").insert({
            actor: this.cfg.actor,
            action,
            document_id: documentId,
            metadata,
        });
        if (error)
            throw new Error(`audit failed: ${error.message}`);
    }
}
//# sourceMappingURL=memory.js.map