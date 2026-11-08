import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { formatDotEnv, meminboxEnvPath, meminboxHome } from "./dotenv.js";
import {
  applySqlFileViaCli,
  detectSupabaseCli,
  getServiceKeyViaCli,
  supabaseUrlForRef,
  type CliProject,
} from "./supabase-cli.js";

/**
 * `meminbox init` — first-time setup for a new user.
 *
 * Preferred path: if the official Supabase CLI is installed and logged
 * in, everything comes from it (project list, the project's own service
 * key, schema application) — no dashboard copy-paste, and the CLI's
 * account token is never seen or stored by meminbox. Falls back to the
 * manual flow below when the CLI is unavailable.
 *
 * 1. Collect Supabase credentials (flags, env, or interactive prompts).
 * 2. Optionally apply the schema: if a Postgres DATABASE_URL is given we
 *    run the migrations directly. It is used once and NOT saved.
 *    Without it, the user pastes the SQL in Supabase's SQL Editor instead.
 * 3. Save runtime config to ~/.meminbox/.env (mode 0600). Client configs
 *    written by `configure-agent` never embed the service role key — the
 *    MCP server reads this file itself.
 * 4. Smoke-test the connection so setup fails here, not inside an agent.
 */

interface InitOptions {
  url?: string;
  serviceKey?: string;
  databaseUrl?: string;
  openaiKey?: string;
  actor?: string;
  project?: string;
  projectRef?: string;
  noCli: boolean;
  noMigrate: boolean;
  force: boolean;
  yes: boolean;
}

function parseFlags(argv: string[]): InitOptions {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    url: get("url") ?? process.env.SUPABASE_URL,
    serviceKey: get("service-key") ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: get("database-url") ?? process.env.DATABASE_URL,
    openaiKey: get("openai-key") ?? process.env.OPENAI_API_KEY,
    actor: get("actor"),
    project: get("project"),
    projectRef: get("project-ref"),
    noCli: argv.includes("--no-cli"),
    noMigrate: argv.includes("--no-migrate"),
    force: argv.includes("--force"),
    yes: argv.includes("--yes"),
  };
}

async function promptSecret(query: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(query);
    rl.close();
    return answer.trim();
  }
  process.stderr.write(query);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (buf: Buffer) => {
      const ch = buf.toString("utf8");
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(value.trim());
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function migrationDir(): string {
  // Works from both src/ (tsx) and dist/ (built): both sit one level
  // below the package root, next to supabase/migrations.
  return fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
}

export function listMigrationSql(): Array<{ name: string; sql: string }> {
  const dir = migrationDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${dir}${name}`, "utf8") }));
}

export function listMigrationFiles(): Array<{ name: string; path: string }> {
  const dir = migrationDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, path: `${dir}${name}` }));
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const m of listMigrationSql()) {
      await client.query(m.sql);
      console.log(`applied migration ${m.name}`);
    }
  } finally {
    await client.end();
  }
}

export async function runInit(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  const envPath = meminboxEnvPath();

  if (existsSync(envPath) && !opts.force) {
    if (opts.yes) {
      throw new Error(`${envPath} already exists. Re-run with --force to overwrite.`);
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`${envPath} already exists. Overwrite? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("aborted — existing config kept");
      return;
    }
  }

  let { url, serviceKey, databaseUrl, openaiKey } = opts;
  let cliSchemaApplied = false;

  // Preferred path: if the official Supabase CLI is installed and logged
  // in, take everything from it. The CLI's access token never leaves the
  // CLI — we only consume its command output.
  if (!url && !serviceKey && !opts.noCli) {
    const det = await detectSupabaseCli();
    if (det.status === "ready" && det.projects.length > 0) {
      let project: CliProject | undefined;
      if (opts.projectRef) {
        project = det.projects.find((p) => p.ref === opts.projectRef);
        if (!project) {
          throw new Error(
            `project ${opts.projectRef} was not returned by \`supabase projects list\``,
          );
        }
      } else if (det.projects.length === 1) {
        project = det.projects[0];
      } else if (!opts.yes) {
        console.log("Supabase CLI detected. Your projects:");
        det.projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.ref})`));
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const answer = await rl.question(`Select project [1-${det.projects.length}]: `);
        rl.close();
        project = det.projects[Number(answer.trim()) - 1];
        if (!project) throw new Error("invalid project selection");
      } else {
        throw new Error(
          "multiple Supabase projects found via CLI; pass --project-ref <ref>",
        );
      }
      console.log(`using Supabase CLI login — project ${project.name} (${project.ref})`);
      serviceKey = await getServiceKeyViaCli(project.ref);
      url = supabaseUrlForRef(project.ref);
      if (!opts.noMigrate) {
        for (const f of listMigrationFiles()) {
          await applySqlFileViaCli(project.ref, f.path);
          console.log(`applied migration ${f.name} via Supabase CLI`);
        }
        cliSchemaApplied = true;
      }
    } else if (!opts.yes) {
      console.log(
        det.status === "not-installed"
          ? "Supabase CLI not found — continuing with manual setup. (Tip: install it and run `supabase login` for the one-step flow.)"
          : "Supabase CLI is not logged in — run `supabase login` for the one-step flow, or continue manually.",
      );
    }
  }

  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    if (!url) url = (await rl.question("Supabase project URL (https://….supabase.co): ")).trim();
    rl.close();
    if (!serviceKey) serviceKey = await promptSecret("Supabase service role key (input hidden): ");
    if (!databaseUrl && !opts.noMigrate && !cliSchemaApplied) {
      databaseUrl = await promptSecret(
        "Postgres connection string for migrations (optional, Enter to skip — you can paste the SQL in the SQL Editor instead): ",
      );
      if (!databaseUrl) databaseUrl = undefined;
    }
    if (!openaiKey) {
      const rl2 = createInterface({ input: process.stdin, output: process.stderr });
      openaiKey = (await rl2.question("OpenAI API key for embeddings (optional, Enter to skip): ")).trim() || undefined;
      rl2.close();
    }
  }
  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and the service role key are required. Pass --url / --service-key or run interactively.",
    );
  }
  if (!/^https:\/\//.test(url)) throw new Error("Supabase URL must start with https://");

  if (cliSchemaApplied) {
    // Schema already applied through the Supabase CLI above.
  } else if (databaseUrl && !opts.noMigrate) {
    await applyMigrations(databaseUrl);
  } else {
    console.log(
      "\nSchema not applied automatically. Paste the migration SQL into your Supabase SQL Editor:\n" +
        listMigrationSql().map((m) => `  - supabase/migrations/${m.name} (in the meminbox package)`).join("\n") +
        "\n",
    );
  }

  mkdirSync(meminboxHome(), { recursive: true, mode: 0o700 });
  const values: Record<string, string> = {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    MEMORY_ACTOR: opts.actor ?? "cli",
    MEMORY_DEFAULT_PROJECT: opts.project ?? "default",
  };
  if (openaiKey) values.OPENAI_API_KEY = openaiKey;
  writeFileSync(envPath, formatDotEnv(values), { mode: 0o600 });
  console.log(`wrote ${envPath} (mode 0600; database URL was not saved)`);

  // Smoke test: proves credentials AND schema in one round trip.
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { error } = await db.from("projects").select("slug").limit(1);
  if (error) {
    console.log(
      `\nConnected to Supabase, but the meminbox schema is not reachable (${error.message}).\n` +
        "If you skipped migrations, apply the SQL first, then verify with: meminbox list",
    );
    return;
  }
  console.log("\nSetup complete. Next steps:");
  console.log("  meminbox configure-agent --tool claude-code   # or codex / cursor / claude-desktop");
  console.log("  meminbox add --title 'First memory' --text '…' --active");
  console.log("  meminbox search 'First memory'");
}
