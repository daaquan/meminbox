#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runConfigureAgent } from "./agents.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { friendlyError, isDebug, SetupCancelled } from "./errors.js";
import { extractCandidates } from "./extract.js";
import { BUILTIN_SOURCES, collectDir, collectSources, type Collected } from "./importers.js";
import { runInit, runMigrate } from "./init.js";
import { MemoryService, type WriteOutcome, type WrittenDocument } from "./memory.js";

/**
 * The human's window into the same memory the agents use.
 *
 * Setup:
 *   meminbox init [--url <url> --service-key <key> --database-url <url>]
 *                 (auto-detects `supabase login` when the Supabase CLI is present)
 *   meminbox configure-agent --tool <claude-code|codex|cursor|claude-desktop> [--print]
 *   meminbox migrate [--project-ref <ref> | --database-url <url>]   (after upgrading)
 *
 * Memory:
 *   meminbox search <query> [--project <slug>]
 *   meminbox add --title <t> [--file <path> | --text <md>] [--active]
 *   meminbox list [--status inbox|active|archived] [--project <slug>]
 *   meminbox promote <id> | archive <id>
 *   meminbox extract --file <transcript>
  meminbox import [--from claude-code,codex,gemini] [--project <slug>] [--active] [--dry-run]
  meminbox import --dir <path> [--agent <name>]   any folder of Markdown (Cursor rules, notes, ...)
 *   meminbox reindex
 *   meminbox projects
 */

const USAGE = `meminbox — shared memory for your AI agents

Get started:
  meminbox init                 connect to your Supabase project
  meminbox configure-agent --tool <claude-code|codex|cursor|claude-desktop>
  meminbox migrate              apply schema updates after upgrading meminbox

Memory commands:
  meminbox search <query> [--project <slug>]
  meminbox add --title <t> [--file <path> | --text <md>] [--active]
  meminbox list [--status inbox|active|archived] [--project <slug>]
  meminbox promote <id> | meminbox archive <id>
  meminbox extract --file <transcript>
  meminbox import [--from claude-code,codex,gemini] [--project <slug>] [--active] [--dry-run]
  meminbox import --dir <path> [--agent <name>]   any folder of Markdown (Cursor rules, notes, ...)
  meminbox reindex
  meminbox projects`;

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
/** Flags that take a value; their values are not positional arguments. */
const VALUE_FLAGS = new Set(["--title", "--file", "--text", "--status", "--project", "--from", "--dir", "--agent"]);
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("--")) out.push(a);
  }
  return out;
}
function positional(i: number): string | undefined {
  return positionals()[i];
}

function describeWrite(doc: WrittenDocument): string {
  switch (doc.outcome) {
    case "duplicate":
      return `= Already stored (identical content, ${doc.status}): ${doc.title} (${doc.id}) — nothing new written`;
    case "updated":
      return `✓ Updated (${doc.status}, v${doc.version}): ${doc.title} (${doc.id})`;
    case "unchanged":
      return `= Unchanged: ${doc.title} (${doc.id})`;
    case "archived":
      return `- Archived earlier, left alone: ${doc.title} (${doc.id})`;
    default:
      return `✓ Saved to ${doc.status}: ${doc.title} (${doc.id})`;
  }
}

const IMPORT_MARK: Record<WriteOutcome, string> = {
  created: "+",
  updated: "~",
  unchanged: "=",
  duplicate: "=",
  archived: "-",
};

async function runImport(memory: MemoryService): Promise<void> {
  const dir = flag("dir");
  const from = flag("from");
  const dryRun = rest.includes("--dry-run");
  const opts = { allowSecrets: rest.includes("--allow-secrets") };
  const projectOverride = flag("project");

  const parts: Collected[] = [];
  if (dir) parts.push(collectDir(dir, flag("agent") ?? "import", opts));
  if (from || !dir) {
    const names = from ? from.split(",").map((s) => s.trim()).filter(Boolean) : [...BUILTIN_SOURCES];
    parts.push(collectSources(names, opts));
  }
  const items = parts.flatMap((p) => p.items);
  const skipped = parts.flatMap((p) => p.skipped);
  for (const n of parts.flatMap((p) => p.notes)) console.log(`  ${n}`);
  for (const s of skipped) console.log(`! skipped ${s.path}: ${s.reason}`);

  const counts: Record<WriteOutcome, number> = { created: 0, updated: 0, unchanged: 0, duplicate: 0, archived: 0 };
  for (const item of items) {
    const project = projectOverride ?? item.projectSlug ?? "(default)";
    if (dryRun) {
      console.log(`  would import [${project}] ${item.title}  ← ${item.path}`);
      continue;
    }
    const doc = await memory.writeDocument({
      title: item.title,
      contentMd: item.contentMd,
      projectSlug: projectOverride ?? item.projectSlug,
      status: rest.includes("--active") ? "active" : undefined,
      sourceKey: item.sourceKey,
      provenance: { agent: item.agent, source: "import", uri: item.path },
    });
    counts[doc.outcome]++;
    const note = doc.outcome === "duplicate" ? "  (identical content already stored)" : doc.outcome === "archived" ? "  (archived earlier, left alone)" : "";
    console.log(`${IMPORT_MARK[doc.outcome]} [${project}] ${doc.title} (${doc.id})${note}`);
  }

  if (dryRun) {
    console.log(`\nDry run: ${items.length} to import, ${skipped.length} skipped. Nothing was written.`);
    return;
  }
  console.log(
    `\n✓ Import done: ${counts.created} new, ${counts.updated} updated, ${counts.unchanged + counts.duplicate} already stored, ` +
      `${counts.archived} archived (left alone), ${skipped.length} skipped.`,
  );
  if (counts.created + counts.updated > 0 && !rest.includes("--active")) {
    console.log("  New and changed documents are in the inbox: review with `meminbox list --status inbox`, then `meminbox promote <id>`.");
  }
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
  if (cmd === "migrate") {
    await runMigrate(rest, cfg.supabaseUrl);
    return;
  }
  const memory = new MemoryService(cfg, createDb(cfg));

  switch (cmd) {
    case "search": {
      const query = positionals().join(" ");
      if (!query) throw new Error("Usage: meminbox search <query> [--project <slug>]");
      const hits = await memory.search(query, { limit: 10, projectSlug: flag("project") });
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
      console.log(describeWrite(doc));
      if (doc.indexError) console.log("  (not indexed for vector search yet — run `meminbox reindex` later)");
      break;
    }
    case "list": {
      const status = flag("status") as
        | "inbox"
        | "active"
        | "archived"
        | undefined;
      const docs = await memory.listDocuments({ status, limit: 50, projectSlug: flag("project") });
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
        console.log(describeWrite(doc));
      }
      if (candidates.length === 0) console.log("Nothing durable found to extract.");
      break;
    }
    case "import": {
      await runImport(memory);
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
