import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";
import { chunkMarkdown } from "./chunk.js";
import { embedBatch, embedText } from "./embeddings.js";
import type {
  DocumentStatus,
  MemoryDocument,
  Provenance,
  SearchHit,
} from "./types.js";

/** pgvector accepts the "[1,2,3]" text literal; use it for inserts and RPC. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export class MemoryService {
  constructor(
    private cfg: Config,
    private db: SupabaseClient,
  ) {}

  // -- projects -------------------------------------------------------------

  async ensureProject(slug: string, name?: string): Promise<string> {
    const { data, error } = await this.db
      .from("meminbox_projects")
      .upsert({ slug, name: name ?? slug }, { onConflict: "slug" })
      .select("id")
      .single();
    if (error) throw new Error(`ensureProject failed: ${error.message}`);
    return data.id as string;
  }

  async listProjects(): Promise<Array<{ slug: string; name: string }>> {
    const { data, error } = await this.db
      .from("meminbox_projects")
      .select("slug, name")
      .order("slug");
    if (error) throw new Error(`listProjects failed: ${error.message}`);
    return data ?? [];
  }

  // -- writes ---------------------------------------------------------------

  /**
   * Write a memory document. Default status is "inbox": agent writes are
   * NOT trusted memory until promoted. That staging step is the guardrail
   * against one agent's mistake becoming every agent's fact.
   */
  async writeDocument(input: {
    title: string;
    contentMd: string;
    projectSlug?: string;
    status?: DocumentStatus;
    provenance?: Provenance;
  }): Promise<MemoryDocument> {
    const projectId = await this.ensureProject(
      input.projectSlug ?? this.cfg.defaultProject,
    );
    const provenance: Provenance = {
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
    if (error) throw new Error(`writeDocument failed: ${error.message}`);
    const doc = data as MemoryDocument;
    await this.indexDocument(doc);
    await this.audit("write", doc.id, { status: doc.status });
    return doc;
  }

  async setStatus(
    id: string,
    status: DocumentStatus,
  ): Promise<MemoryDocument> {
    const { data, error } = await this.db
      .from("meminbox_documents")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`setStatus failed: ${error.message}`);
    await this.audit(
      status === "active" ? "promote" : status === "archived" ? "archive" : "demote",
      id,
      { status },
    );
    return data as MemoryDocument;
  }

  async getDocument(id: string): Promise<MemoryDocument | null> {
    const { data, error } = await this.db
      .from("meminbox_documents")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getDocument failed: ${error.message}`);
    return (data as MemoryDocument) ?? null;
  }

  async listDocuments(opts: {
    status?: DocumentStatus;
    limit?: number;
  } = {}): Promise<MemoryDocument[]> {
    let q = this.db
      .from("meminbox_documents")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(opts.limit ?? 50);
    if (opts.status) q = q.eq("status", opts.status);
    const { data, error } = await q;
    if (error) throw new Error(`listDocuments failed: ${error.message}`);
    return (data ?? []) as MemoryDocument[];
  }

  // -- derived index ----------------------------------------------------------

  /** Rebuild the chunk/embedding index for one document. Safe to re-run. */
  async indexDocument(doc: Pick<MemoryDocument, "id" | "title" | "content_md">) {
    const chunks = chunkMarkdown(`${doc.title}\n\n${doc.content_md}`);
    const embeddings = await embedBatch(this.cfg, chunks);
    const { error: delError } = await this.db
      .from("meminbox_document_chunks")
      .delete()
      .eq("document_id", doc.id);
    if (delError) throw new Error(`indexDocument delete failed: ${delError.message}`);
    if (chunks.length === 0) return;
    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i] ? toVectorLiteral(embeddings[i]!) : null,
    }));
    const { error } = await this.db.from("meminbox_document_chunks").insert(rows);
    if (error) throw new Error(`indexDocument insert failed: ${error.message}`);
  }

  /** Rebuild the derived index for every document. The index is disposable. */
  async reindexAll(): Promise<number> {
    const docs = await this.listDocuments({ limit: 1000 });
    for (const doc of docs) await this.indexDocument(doc);
    await this.audit("reindex", null, { documents: docs.length });
    return docs.length;
  }

  // -- search ---------------------------------------------------------------

  /**
   * Hybrid search: keyword (FTS + substring fallback in SQL) merged with
   * vector similarity when embeddings are configured. Keyword-only is a
   * fully supported mode — for a personal-scale memory it is often enough.
   */
  async search(
    query: string,
    opts: { limit?: number; status?: DocumentStatus; projectSlug?: string } = {},
  ): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10;
    const status = opts.status ?? "active";
    const byDoc = new Map<string, SearchHit>();

    // Keyword path
    const { data: kw, error: kwError } = await this.db.rpc("meminbox_search_documents", {
      p_query: query,
      p_limit: limit * 3,
      p_status: status,
    });
    if (kwError) throw new Error(`search (keyword) failed: ${kwError.message}`);
    const kwRows = (kw ?? []) as Array<{
      id: string;
      title: string;
      content_md: string;
      rank: number;
    }>;
    const maxRank = Math.max(...kwRows.map((r) => r.rank), 0);
    for (const row of kwRows) {
      byDoc.set(row.id, {
        documentId: row.id,
        title: row.title,
        snippet: row.content_md.slice(0, 300),
        score: maxRank > 0 ? row.rank / maxRank : 0.5,
        via: ["keyword"],
      });
    }

    // Vector path (only when an embedding provider is configured)
    const queryVec = await embedText(this.cfg, query);
    if (queryVec) {
      const { data: vec, error: vecError } = await this.db.rpc("meminbox_match_chunks", {
        p_embedding: toVectorLiteral(queryVec),
        p_limit: limit * 3,
        p_status: status,
      });
      if (vecError) throw new Error(`search (vector) failed: ${vecError.message}`);
      const vecRows = (vec ?? []) as Array<{
        document_id: string;
        title: string;
        chunk: string;
        similarity: number;
      }>;
      for (const row of vecRows) {
        const existing = byDoc.get(row.document_id);
        if (existing) {
          existing.via.push("vector");
          existing.score = Math.min(1, existing.score * 0.5 + row.similarity * 0.5);
          if (row.chunk.length > 0) existing.snippet = row.chunk.slice(0, 300);
        } else {
          byDoc.set(row.document_id, {
            documentId: row.document_id,
            title: row.title,
            snippet: row.chunk.slice(0, 300),
            score: row.similarity,
            via: ["vector"],
          });
        }
      }
    }

    return [...byDoc.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // -- audit ------------------------------------------------------------------

  private async audit(
    action: string,
    documentId: string | null,
    metadata: Record<string, unknown>,
  ) {
    const { error } = await this.db.from("meminbox_audit_log").insert({
      actor: this.cfg.actor,
      action,
      document_id: documentId,
      metadata,
    });
    if (error) throw new Error(`audit failed: ${error.message}`);
  }
}
