import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { formatDotEnv, meminboxEnvPath, meminboxHome, writePrivateFile } from "./dotenv.js";
import { SetupCancelled } from "./errors.js";
import {
  applySqlFileViaCli,
  classifySupabaseKey,
  detectSupabaseCli,
  getServiceKeyViaCli,
  refFromSupabaseUrl,
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
    url: get("url") ?? process.env.MEMINBOX_SUPABASE_URL,
    serviceKey: get("service-key") ?? process.env.MEMINBOX_SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: get("database-url") ?? process.env.MEMINBOX_DATABASE_URL,
    openaiKey: get("openai-key") ?? process.env.MEMINBOX_OPENAI_API_KEY,
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
  try {
    await client.connect();
    for (const m of listMigrationSql()) {
      await client.query(m.sql);
      console.log(`✓ Applied migration ${m.name}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(
      `Could not apply the migrations with that connection string (${detail}). ` +
        "Check the host and database password — or skip this step and apply the SQL from supabase/migrations/ in the dashboard's SQL Editor.",
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * `meminbox migrate` — apply the bundled migrations to the ALREADY
 * configured project (e.g. after upgrading meminbox). Uses a one-off
 * Postgres connection string when given, otherwise the Supabase CLI.
 */
export async function runMigrate(argv: string[], supabaseUrl: string): Promise<void> {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const databaseUrl = get("database-url");
  if (databaseUrl) {
    await applyMigrations(databaseUrl);
    console.log("✓ Schema is up to date. The connection string was used once and was not saved.");
    return;
  }
  const ref = get("project-ref") ?? refFromSupabaseUrl(supabaseUrl);
  if (!ref) {
    throw new Error(
      `Cannot tell the project ref from ${supabaseUrl}. Pass --project-ref <ref> or --database-url <postgres-url>.`,
    );
  }
  const det = await detectSupabaseCli();
  if (det.status !== "ready") {
    throw new Error(
      "The Supabase CLI is not available or not logged in. Run `supabase login`, or pass --database-url <postgres-url>, " +
        "or paste the files in supabase/migrations/ into the dashboard's SQL Editor.",
    );
  }
  console.log(`Applying meminbox migrations to the configured project (${ref})…`);
  for (const f of listMigrationFiles()) {
    await applySqlFileViaCli(ref, f.path);
    console.log(`✓ Applied migration ${f.name}`);
  }
  console.log("✓ Schema is up to date.");
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Pick the Supabase project init will write meminbox's schema into.
 *
 * Never chosen silently: a `supabase link` in the current directory or a
 * single-project account is only a SUGGESTION the user must confirm,
 * because the link usually points at the app repo's own (often
 * production) project. Non-interactive runs need --project-ref unless
 * the account has exactly one project.
 */
export async function chooseCliProject(
  projects: CliProject[],
  opts: Pick<InitOptions, "projectRef" | "yes">,
  prompt: (q: string) => Promise<string> = ask,
): Promise<CliProject> {
  if (opts.projectRef) {
    const project = projects.find((p) => p.ref === opts.projectRef);
    if (!project) {
      throw new Error(
        `project ${opts.projectRef} was not returned by \`supabase projects list\``,
      );
    }
    return project;
  }
  if (opts.yes) {
    if (projects.length === 1) return projects[0]!;
    throw new Error(
      "multiple Supabase projects found via CLI; pass --project-ref <ref> to choose one non-interactively",
    );
  }

  const suggested =
    projects.find((p) => p.linked) ?? (projects.length === 1 ? projects[0] : undefined);
  if (suggested) {
    const why = suggested.linked
      ? "it is the project `supabase link` points at in this directory"
      : "it is the only project on your Supabase account";
    console.log(`Supabase CLI detected. Suggested project: ${suggested.name} (${suggested.ref}) — ${why}.`);
    console.log("meminbox will create its own tables (meminbox_*) in this project. Use a dedicated project, not an app's.");
    const answer = await prompt(`Use ${suggested.name} (${suggested.ref})? [y/N] `);
    if (/^y(es)?$/i.test(answer)) return suggested;
    if (projects.length === 1) {
      throw new SetupCancelled(
        "Setup cancelled — nothing was changed. Create a dedicated Supabase project for meminbox, then run `meminbox init` again (or use --no-cli for manual setup).",
      );
    }
  }

  console.log("Your Supabase projects:");
  projects.forEach((p, i) =>
    console.log(`  ${i + 1}. ${p.name} (${p.ref})${p.linked ? "  ← linked here" : ""}`),
  );
  const answer = await prompt(`Select project [1-${projects.length}]: `);
  const project = projects[Number(answer) - 1];
  if (!project) throw new Error("invalid project selection");
  return project;
}

export async function runInit(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  const envPath = meminboxEnvPath();

  console.log("meminbox init — connect meminbox to a Supabase project.\n");

  if (existsSync(envPath) && !opts.force) {
    if (opts.yes) {
      throw new Error(
        `A configuration already exists at ${envPath}. Re-run with --force to replace it.`,
      );
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`${envPath} already exists. Overwrite? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new SetupCancelled(
        "Setup cancelled — your existing configuration was kept.",
      );
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
      const project = await chooseCliProject(det.projects, opts);
      console.log(`✓ Detected Supabase CLI login — using project ${project.name} (${project.ref})`);
      serviceKey = await getServiceKeyViaCli(project.ref);
      url = supabaseUrlForRef(project.ref);
      if (!opts.noMigrate) {
        for (const f of listMigrationFiles()) {
          await applySqlFileViaCli(project.ref, f.path);
          console.log(`✓ Applied migration ${f.name} via Supabase CLI`);
        }
        cliSchemaApplied = true;
      }
    } else if (!opts.yes) {
      if (det.status === "not-installed") {
        console.log(
          "Supabase CLI not found — continuing with manual setup. (Tip: install it and run `supabase login` for the one-step flow.)",
        );
      } else if (det.status === "not-logged-in") {
        console.log(
          "Supabase CLI is not logged in — run `supabase login` for the one-step flow, or continue manually.",
        );
      } else if (det.status === "error") {
        console.log(
          `Supabase CLI was found, but listing projects failed — continuing with manual setup.\n  Reason: ${det.detail}`,
        );
      }
    }
  }

  if (!opts.yes) {
    if (!url) {
      console.log(
        "Find the project URL and keys in the Supabase dashboard: Project Settings → API.\n",
      );
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    if (!url) url = (await rl.question("Supabase project URL (https://….supabase.co): ")).trim();
    rl.close();
    if (!url) {
      throw new SetupCancelled(
        "Setup cancelled — no project URL was entered, and nothing was saved.\n" +
          "Tip: with the Supabase CLI installed, run `supabase login` first and init will detect your projects automatically.",
      );
    }
    if (!serviceKey) serviceKey = await promptSecret("Supabase service role key (input hidden): ");
    if (!serviceKey) {
      throw new SetupCancelled(
        "Setup cancelled — no service role key was entered, and nothing was saved.\n" +
          "The key is labelled service_role (or starts with sb_secret_) under Project Settings → API. The anon / publishable key will not work.",
      );
    }
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
      "Missing required values for non-interactive setup: pass --url <project-url> and --service-key <key>, or run `meminbox init` interactively.",
    );
  }
  if (!/^https:\/\//.test(url)) throw new Error("Supabase URL must start with https://");
  if (classifySupabaseKey(serviceKey) === "anon") {
    throw new Error(
      "That key is the anon / publishable key — it is constrained by RLS and cannot write memory. " +
        "Use the service role (secret) key instead: Supabase Dashboard → Project Settings → API. " +
        "Nothing was saved.",
    );
  }

  if (cliSchemaApplied) {
    // Schema already applied through the Supabase CLI above.
  } else if (databaseUrl && !opts.noMigrate) {
    await applyMigrations(databaseUrl);
  } else if (!opts.noMigrate) {
    console.log(
      "\nOne step left — the database schema is not applied yet. Either:\n" +
        "  • paste the migration SQL into the Supabase dashboard's SQL Editor:\n" +
        listMigrationSql().map((m) => `      supabase/migrations/${m.name} (in the meminbox package)`).join("\n") +
        "\n  • or run: supabase db query --remote=<project-ref> -f supabase/migrations/<file>\n",
    );
  }

  const values: Record<string, string> = {
    MEMINBOX_SUPABASE_URL: url,
    MEMINBOX_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    MEMINBOX_ACTOR: opts.actor ?? "cli",
    MEMINBOX_DEFAULT_PROJECT: opts.project ?? "default",
  };
  if (openaiKey) values.MEMINBOX_OPENAI_API_KEY = openaiKey;
  writePrivateFile(envPath, meminboxHome(), formatDotEnv(values));
  console.log(`✓ Configuration saved to ${envPath} (file permissions 0600)`);
  if (databaseUrl) console.log("  The migration connection string was used once and was not saved.");

  // Smoke test: proves credentials AND schema in one round trip.
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { error } = await db.from("meminbox_projects").select("slug").limit(1);
  if (error) {
    console.log(
      "\nYour configuration is saved, but the meminbox tables are not reachable yet.\n" +
        "Most likely the schema has not been applied to this project. Apply the migration\n" +
        "above, then verify with: meminbox list",
    );
    return;
  }
  console.log("\n✓ Setup complete — meminbox is connected to your Supabase project.");
  console.log("\nNext steps:");
  console.log("  meminbox configure-agent --tool claude-code   # or codex / cursor / claude-desktop");
  console.log("  meminbox add --title 'First memory' --text '…' --active");
  console.log("  meminbox search 'First memory'");
}
