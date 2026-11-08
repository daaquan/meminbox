import { execFile } from "node:child_process";

/**
 * Integration with the official Supabase CLI.
 *
 * Security posture: meminbox NEVER sees or stores the user's Supabase
 * account access token. The token stays inside the CLI's own credential
 * store; we only invoke the CLI as a subprocess and consume its output:
 *
 *   supabase projects list                        -> login detection + refs
 *   supabase projects api-keys --remote=<ref> --reveal
 *                                                 -> the project's own keys
 *   supabase db query --remote=<ref> -f file.sql  -> schema application
 *
 * The only secret meminbox persists is the project's service key in
 * ~/.meminbox/.env — exactly what the manual flow would have the user
 * copy from the dashboard.
 */

export interface CliProject {
  ref: string;
  name: string;
}

export interface ApiKeyEntry {
  name?: string;
  type?: string;
  api_key?: string;
  [key: string]: unknown;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSupabase(args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      "supabase",
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          // ENOENT etc. — binary missing or killed.
          resolve({ code: -1, stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message) });
          return;
        }
        resolve({
          code: err ? Number((err as { code: number }).code) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

async function runSupabaseJson(args: string[]): Promise<unknown> {
  // v3 uses --output-format json; v2 used -o json. Try v3 first and fall
  // back if the flag itself is rejected.
  for (const formatArgs of [["--output-format", "json"], ["-o", "json"]]) {
    const r = await runSupabase([...args, ...formatArgs]);
    if (r.code === 0) {
      try {
        return JSON.parse(r.stdout);
      } catch {
        throw new Error(`supabase CLI returned non-JSON output for: supabase ${args.join(" ")}`);
      }
    }
    if (!/unknown flag|unknown shorthand|invalid argument/i.test(r.stderr)) {
      throw new Error(r.stderr.trim() || `supabase ${args.join(" ")} failed`);
    }
  }
  throw new Error(`supabase ${args.join(" ")} failed`);
}

/** Parse `supabase projects list` JSON into {ref, name} pairs. */
export function parseProjectsList(data: unknown): CliProject[] {
  if (!Array.isArray(data)) return [];
  const out: CliProject[] = [];
  for (const item of data as Array<Record<string, unknown>>) {
    const ref =
      (typeof item.id === "string" && item.id) ||
      (typeof item.ref === "string" && item.ref) ||
      "";
    if (!ref) continue;
    out.push({ ref, name: typeof item.name === "string" ? item.name : ref });
  }
  return out;
}

/**
 * Choose the privileged key from `projects api-keys` output.
 * Handles both the legacy JWT keys (name "service_role") and the new
 * key format (type "secret", values starting sb_secret_). Publishable /
 * anon keys are never selected.
 */
export function pickServiceKey(entries: ApiKeyEntry[]): string | null {
  const usable = entries.filter((e) => typeof e.api_key === "string" && e.api_key);
  const legacy = usable.find((e) => e.name === "service_role");
  if (legacy) return legacy.api_key!;
  const secret = usable.find((e) => e.type === "secret");
  if (secret) return secret.api_key!;
  const sbSecret = usable.find((e) => e.api_key!.startsWith("sb_secret_"));
  if (sbSecret) return sbSecret.api_key!;
  return null;
}

export function parseApiKeys(data: unknown): ApiKeyEntry[] {
  if (!Array.isArray(data)) return [];
  return data as ApiKeyEntry[];
}

export function supabaseUrlForRef(ref: string): string {
  return `https://${ref}.supabase.co`;
}

export type CliDetection =
  | { status: "not-installed" }
  | { status: "not-logged-in" }
  | { status: "ready"; projects: CliProject[] };

/** Detect the Supabase CLI and, if logged in, list its projects. */
export async function detectSupabaseCli(): Promise<CliDetection> {
  const version = await runSupabase(["--version"], 15_000);
  if (version.code !== 0) return { status: "not-installed" };
  const list = await runSupabase(["projects", "list", "--output-format", "json"], 30_000);
  if (list.code !== 0) {
    if (/access token not provided|not logged in/i.test(list.stderr)) {
      return { status: "not-logged-in" };
    }
    return { status: "not-logged-in" };
  }
  try {
    return { status: "ready", projects: parseProjectsList(JSON.parse(list.stdout)) };
  } catch {
    return { status: "not-logged-in" };
  }
}

/** Fetch the project's privileged (service) key via the CLI. */
export async function getServiceKeyViaCli(ref: string): Promise<string> {
  const data = await runSupabaseJson([
    "projects",
    "api-keys",
    `--remote=${ref}`,
    "--reveal",
  ]);
  const key = pickServiceKey(parseApiKeys(data));
  if (!key) {
    throw new Error(
      "No service/secret key found in `supabase projects api-keys` output. " +
        "Copy the service role key from the Supabase dashboard instead.",
    );
  }
  return key;
}

/** Apply one SQL file to a remote project via the CLI. */
export async function applySqlFileViaCli(ref: string, filePath: string): Promise<void> {
  const r = await runSupabase(
    ["db", "query", `--remote=${ref}`, "-f", filePath, "--yes"],
    120_000,
  );
  if (r.code !== 0) {
    throw new Error(
      `supabase db query failed for ${filePath}: ${r.stderr.trim().slice(0, 400)}`,
    );
  }
}
