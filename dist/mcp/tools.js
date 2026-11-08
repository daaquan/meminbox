import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractCandidates } from "../extract.js";
function text(payload) {
    return {
        content: [
            {
                type: "text",
                text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
            },
        ],
    };
}
/**
 * Build the meminbox MCP server (tools only; the caller picks a transport).
 *
 * The inbox is the quality gate for shared memory, so by default agents
 * can only WRITE TO THE INBOX: promoting, archiving and writing straight
 * to active memory are human actions (`meminbox promote` / `archive`).
 * Set MEMINBOX_ALLOW_AGENT_PROMOTE=1 to hand those to agents as well.
 */
export function createMcpServer(cfg, memory, version) {
    const server = new McpServer({ name: "meminbox", version });
    const agentsMayPromote = cfg.allowAgentPromote;
    server.registerTool("memory_search", {
        description: "Search shared active memory across all agents. Returns the most relevant documents (hybrid keyword + vector when embeddings are configured).",
        inputSchema: {
            query: z.string().min(1),
            limit: z.number().int().min(1).max(50).optional(),
            includeInbox: z.boolean().optional(),
            project: z.string().optional().describe("Only search this project (slug). Omit to search all projects."),
        },
    }, async ({ query, limit, includeInbox, project }) => {
        const active = await memory.search(query, { limit, projectSlug: project });
        if (!includeInbox)
            return text(active);
        const inbox = await memory.search(query, { limit, status: "inbox", projectSlug: project });
        return text({ active, inbox });
    });
    server.registerTool("memory_read", {
        description: "Read one memory document in full by its id.",
        inputSchema: { id: z.string().uuid() },
    }, async ({ id }) => {
        const doc = await memory.getDocument(id);
        return text(doc ?? "not found");
    });
    server.registerTool("memory_write", {
        description: agentsMayPromote
            ? "Write a memory document. It lands in the INBOX by default — it becomes trusted, searchable-by-default memory only after memory_promote. Pass status 'active' only for content a human has already reviewed."
            : "Write a memory document to the INBOX. A human reviews the inbox and promotes documents to trusted, searchable-by-default memory.",
        inputSchema: {
            title: z.string().min(1),
            content: z.string().min(1),
            project: z.string().optional(),
            status: (agentsMayPromote ? z.enum(["inbox", "active"]) : z.enum(["inbox"])).optional(),
            source: z.string().optional(),
        },
    }, async ({ title, content, project, status, source }) => {
        const doc = await memory.writeDocument({
            title,
            contentMd: content,
            projectSlug: project,
            status,
            provenance: { source: source ?? "agent-write" },
        });
        return text({
            id: doc.id,
            status: doc.status,
            title: doc.title,
            ...(doc.indexError ? { warning: `saved, but not indexed for vector search: ${doc.indexError}` } : {}),
        });
    });
    server.registerTool("memory_extract", {
        description: "Extract durable knowledge candidates from raw text (e.g. a session transcript) and file them in the inbox for review. Extraction never writes active memory directly.",
        inputSchema: {
            text: z.string().min(1),
            project: z.string().optional(),
        },
    }, async ({ text: raw, project }) => {
        const candidates = await extractCandidates(cfg, raw);
        const written = [];
        for (const c of candidates) {
            const doc = await memory.writeDocument({
                title: c.title,
                contentMd: c.contentMd,
                projectSlug: project,
                provenance: { source: "extraction" },
            });
            written.push({ id: doc.id, title: doc.title });
        }
        return text({ filedToInbox: written });
    });
    if (agentsMayPromote)
        server.registerTool("memory_promote", {
            description: "Promote an inbox document to active (trusted) memory, or archive a document. This is the quality gate for shared memory.",
            inputSchema: {
                id: z.string().uuid(),
                action: z.enum(["promote", "archive"]),
            },
        }, async ({ id, action }) => {
            const doc = await memory.setStatus(id, action === "promote" ? "active" : "archived");
            return text({ id: doc.id, status: doc.status });
        });
    server.registerTool("memory_list", {
        description: "List recent memory documents, optionally filtered by status and project.",
        inputSchema: {
            status: z.enum(["inbox", "active", "archived"]).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            project: z.string().optional(),
        },
    }, async ({ status, limit, project }) => {
        const docs = await memory.listDocuments({ status, limit, projectSlug: project });
        return text(docs.map((d) => ({
            id: d.id,
            title: d.title,
            status: d.status,
            source_agent: d.source_agent,
            updated_at: d.updated_at,
        })));
    });
    server.registerTool("memory_projects", {
        description: "List memory projects (namespaces).",
        inputSchema: {},
    }, async () => text(await memory.listProjects()));
    return server;
}
//# sourceMappingURL=tools.js.map