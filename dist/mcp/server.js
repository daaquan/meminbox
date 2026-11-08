#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { extractCandidates } from "../extract.js";
import { MemoryService } from "../memory.js";
/**
 * Unified memory interface for agents.
 *
 * Every MCP client (Claude Code, Codex, Cursor, ...) pointed at the same
 * Supabase project reads and writes the same memory. Writes default to the
 * inbox; search reads active memory. Set MEMORY_ACTOR per client so the
 * audit log and provenance show WHICH agent wrote what.
 */
const cfg = loadConfig();
const memory = new MemoryService(cfg, createDb(cfg));
const server = new McpServer({ name: "meminbox", version: "0.2.0" });
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
server.registerTool("memory_search", {
    description: "Search shared active memory across all agents. Returns the most relevant documents (hybrid keyword + vector when embeddings are configured).",
    inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        includeInbox: z.boolean().optional(),
    },
}, async ({ query, limit, includeInbox }) => {
    const active = await memory.search(query, { limit });
    if (!includeInbox)
        return text(active);
    const inbox = await memory.search(query, { limit, status: "inbox" });
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
    description: "Write a memory document. It lands in the INBOX by default — it becomes trusted, searchable-by-default memory only after memory_promote. Pass status 'active' only for content a human has already reviewed.",
    inputSchema: {
        title: z.string().min(1),
        content: z.string().min(1),
        project: z.string().optional(),
        status: z.enum(["inbox", "active"]).optional(),
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
    return text({ id: doc.id, status: doc.status, title: doc.title });
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
    description: "List recent memory documents, optionally filtered by status.",
    inputSchema: {
        status: z.enum(["inbox", "active", "archived"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
    },
}, async ({ status, limit }) => {
    const docs = await memory.listDocuments({ status, limit });
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
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=server.js.map