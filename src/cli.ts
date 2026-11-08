#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runConfigureAgent } from "./agents.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { friendlyError, isDebug, SetupCancelled } from "./errors.js";
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

const USAGE = `meminbox — shared memory for your AI agents

Get started:
  meminbox init                 connect to your Supabase project
  meminbox configure-agent --tool <claude-code|codex|cursor|claude-desktop>

Memory commands:
  meminbox search <query>
  meminbox add --title <t> [--file <path> | --text <md>] [--active]
  meminbox list [--status inbox|active|archived]
  meminbox promote <id> | meminbox archive <id>
  meminbox extract --file <transcript>
  meminbox reindex
  meminbox projects`;

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
function positional(i: number): string | undefined {
  return rest.filter((a) => !a.startsWith("--"))[i];
}

async function main(): Promise<void> {
  // Setup commands run BEFORE any config exists — they must not load it.
  if (cmd === "init") {
    await runInit(rest);
    return;
  }
  if (cmd === "configure-agent") {
    runConfigureAgent(rest);
    return;
  }
  if (cmd === undefined) {
    console.log(USAGE);
    return;
  }

  const cfg = loadConfig();
  const memory = new MemoryService(cfg, createDb(cfg));

  switch (cmd) {
    case "search": {
      const query = rest.join(" ");
      if (!query) throw new Error("Usage: meminbox search <query>");
      const hits = await memory.search(query, { limit: 10 });
      for (const h of hits) {
        console.log(`\n## ${h.title}  [${h.documentId}] score=${h.score.toFixed(2)} via=${h.via.join("+")}`);
        console.log(h.snippet.replace(/\s+/g, " ").trim());
      }
      if (hits.length === 0) console.log("No matches.");
      break;
    }
    case "add": {
      const title = flag("title");
      if (!title) throw new Error("Usage: meminbox add --title <t> [--file <path> | --text <md>] [--active]");
      const content = flag("file")
        ? readFileSync(flag("file")!, "utf8")
        : (flag("text") ?? "");
      if (!content) throw new Error("Nothing to save: pass --file <path> or --text <markdown>.");
      const doc = await memory.writeDocument({
        title,
        contentMd: content,
        projectSlug: flag("project"),
        status: rest.includes("--active") ? "active" : "inbox",
        provenance: { source: "cli" },
      });
      console.log(`✓ Saved to ${doc.status}: ${doc.title} (${doc.id})`);
      break;
    }
    case "list": {
      const status = flag("status") as
        | "inbox"
        | "active"
        | "archived"
        | undefined;
      const docs = await memory.listDocuments({ status, limit: 50 });
      if (docs.length === 0) {
        console.log(status ? `No ${status} documents yet.` : "No documents yet. Add one with: meminbox add --title <t> --text <md>");
      }
      for (const d of docs) {
        console.log(`${d.status.padEnd(8)} ${d.id}  ${d.title}  (${d.source_agent ?? "?"}, ${d.updated_at})`);
      }
      break;
    }
    case "promote":
    case "archive": {
      const id = positional(0);
      if (!id) throw new Error(`Usage: meminbox ${cmd} <id>`);
      const doc = await memory.setStatus(id, cmd === "promote" ? "active" : "archived");
      console.log(`✓ ${doc.status}: ${doc.title} (${doc.id})`);
      break;
    }
    case "extract": {
      const file = flag("file");
      if (!file) throw new Error("Usage: meminbox extract --file <transcript>");
      const candidates = await extractCandidates(cfg, readFileSync(file, "utf8"));
      for (const c of candidates) {
        const doc = await memory.writeDocument({
          title: c.title,
          contentMd: c.contentMd,
          provenance: { source: "extraction" },
        });
        console.log(`✓ Filed to inbox: ${doc.title} (${doc.id})`);
      }
      if (candidates.length === 0) console.log("Nothing durable found to extract.");
      break;
    }
    case "reindex": {
      const n = await memory.reindexAll();
      console.log(`✓ Reindexed ${n} documents.`);
      break;
    }
    case "projects": {
      for (const p of await memory.listProjects()) console.log(`${p.slug}\t${p.name}`);
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof SetupCancelled) {
    console.log(err.message);
    process.exitCode = 1;
  } else {
    console.error(`✗ ${friendlyError(err)}`);
    if (isDebug()) console.error(err);
    process.exitCode = 1;
  }
}
