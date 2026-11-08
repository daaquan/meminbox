#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runConfigureAgent } from "./agents.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { extractCandidates } from "./extract.js";
import { runInit } from "./init.js";
import { MemoryService } from "./memory.js";
/**
 * The human's window into the same memory the agents use.
 *
 * Setup:
 *   meminbox init [--url <url> --service-key <key> --database-url <url>]
 *                 (auto-detects `supabase login` when the Supabase CLI is present)
 *   meminbox configure-agent --tool <claude-code|codex|cursor|claude-desktop> [--print]
 *
 * Memory:
 *   meminbox search <query>
 *   meminbox add --title <t> [--file <path> | --text <md>] [--active]
 *   meminbox list [--status inbox|active|archived]
 *   meminbox promote <id> | archive <id>
 *   meminbox extract --file <transcript>
 *   meminbox reindex
 *   meminbox projects
 */
const [cmd, ...rest] = process.argv.slice(2);
function flag(name) {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
}
function positional(i) {
    return rest.filter((a) => !a.startsWith("--"))[i];
}
// Setup commands run BEFORE any config exists — they must not load it.
if (cmd === "init") {
    await runInit(rest);
    process.exit(0);
}
if (cmd === "configure-agent") {
    runConfigureAgent(rest);
    process.exit(0);
}
let cfg;
let memory;
try {
    cfg = loadConfig();
    memory = new MemoryService(cfg, createDb(cfg));
}
catch (err) {
    if (cmd === undefined) {
        console.log("usage: meminbox <init|configure-agent|search|add|list|promote|archive|extract|reindex|projects>\n" +
            "start with: meminbox init");
        process.exit(0);
    }
    throw err;
}
switch (cmd) {
    case "search": {
        const query = rest.join(" ");
        if (!query)
            throw new Error("usage: meminbox search <query>");
        const hits = await memory.search(query, { limit: 10 });
        for (const h of hits) {
            console.log(`\n## ${h.title}  [${h.documentId}] score=${h.score.toFixed(2)} via=${h.via.join("+")}`);
            console.log(h.snippet.replace(/\s+/g, " ").trim());
        }
        if (hits.length === 0)
            console.log("no hits");
        break;
    }
    case "add": {
        const title = flag("title");
        if (!title)
            throw new Error("usage: meminbox add --title <t> [--file <path> | --text <md>]");
        const content = flag("file")
            ? readFileSync(flag("file"), "utf8")
            : (flag("text") ?? "");
        if (!content)
            throw new Error("provide --file or --text");
        const doc = await memory.writeDocument({
            title,
            contentMd: content,
            projectSlug: flag("project"),
            status: rest.includes("--active") ? "active" : "inbox",
            provenance: { source: "cli" },
        });
        console.log(`${doc.status}: ${doc.id} ${doc.title}`);
        break;
    }
    case "list": {
        const status = flag("status");
        const docs = await memory.listDocuments({ status, limit: 50 });
        for (const d of docs) {
            console.log(`${d.status.padEnd(8)} ${d.id}  ${d.title}  (${d.source_agent ?? "?"}, ${d.updated_at})`);
        }
        break;
    }
    case "promote":
    case "archive": {
        const id = positional(0);
        if (!id)
            throw new Error(`usage: meminbox ${cmd} <id>`);
        const doc = await memory.setStatus(id, cmd === "promote" ? "active" : "archived");
        console.log(`${doc.status}: ${doc.id} ${doc.title}`);
        break;
    }
    case "extract": {
        const file = flag("file");
        if (!file)
            throw new Error("usage: meminbox extract --file <transcript>");
        const candidates = await extractCandidates(cfg, readFileSync(file, "utf8"));
        for (const c of candidates) {
            const doc = await memory.writeDocument({
                title: c.title,
                contentMd: c.contentMd,
                provenance: { source: "extraction" },
            });
            console.log(`inbox: ${doc.id} ${doc.title}`);
        }
        if (candidates.length === 0)
            console.log("nothing durable extracted");
        break;
    }
    case "reindex": {
        const n = await memory.reindexAll();
        console.log(`reindexed ${n} documents`);
        break;
    }
    case "projects": {
        for (const p of await memory.listProjects())
            console.log(`${p.slug}\t${p.name}`);
        break;
    }
    default:
        console.log("usage: meminbox <init|configure-agent|search|add|list|promote|archive|extract|reindex|projects>");
        process.exit(cmd ? 1 : 0);
}
//# sourceMappingURL=cli.js.map