import { execFile } from "node:child_process";
function runSupabase(args, timeoutMs = 60_000) {
    return new Promise((resolve) => {
        execFile("supabase", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err && typeof err.code !== "number") {
                // ENOENT etc. — binary missing or killed.
                resolve({ code: -1, stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message) });
                return;
            }
            resolve({
                code: err ? Number(err.code) : 0,
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
            });
        });
    });
}
async function runSupabaseJson(args) {
    // v3 uses --output-format json; v2 used -o json. Try v3 first and fall
    // back if the flag itself is rejected.
    for (const formatArgs of [["--output-format", "json"], ["-o", "json"]]) {
        const r = await runSupabase([...args, ...formatArgs]);
        if (r.code === 0) {
            try {
                return JSON.parse(r.stdout);
            }
            catch {
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
export function parseProjectsList(data) {
    if (!Array.isArray(data))
        return [];
    const out = [];
    for (const item of data) {
        const ref = (typeof item.id === "string" && item.id) ||
            (typeof item.ref === "string" && item.ref) ||
            "";
        if (!ref)
            continue;
        out.push({
            ref,
            name: typeof item.name === "string" ? item.name : ref,
            linked: item.linked === true,
        });
    }
    return out;
}
/**
 * Choose the privileged key from `projects api-keys` output.
 * Handles both the legacy JWT keys (name "service_role") and the new
 * key format (type "secret", values starting sb_secret_). Publishable /
 * anon keys are never selected.
 */
export function pickServiceKey(entries) {
    const usable = entries.filter((e) => typeof e.api_key === "string" && e.api_key);
    const legacy = usable.find((e) => e.name === "service_role");
    if (legacy)
        return legacy.api_key;
    const secret = usable.find((e) => e.type === "secret");
    if (secret)
        return secret.api_key;
    const sbSecret = usable.find((e) => e.api_key.startsWith("sb_secret_"));
    if (sbSecret)
        return sbSecret.api_key;
    return null;
}
export function parseApiKeys(data) {
    if (!Array.isArray(data))
        return [];
    return data;
}
export function supabaseUrlForRef(ref) {
    return `https://${ref}.supabase.co`;
}
/**
 * Classify a Supabase API key WITHOUT contacting the server.
 * Legacy keys are JWTs whose payload carries a `role` claim; new keys
 * are self-describing via their sb_secret_ / sb_publishable_ prefix.
 * Used by init to catch the classic mistake — pasting the anon key —
 * before it fails later as a confusing RLS error.
 */
export function classifySupabaseKey(key) {
    if (key.startsWith("sb_secret_"))
        return "service";
    if (key.startsWith("sb_publishable_"))
        return "anon";
    const parts = key.split(".");
    if (parts.length === 3) {
        try {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
            if (payload.role === "service_role")
                return "service";
            if (payload.role === "anon")
                return "anon";
        }
        catch {
            // Not a decodable JWT — fall through to unknown.
        }
    }
    return "unknown";
}
/** Detect the Supabase CLI and, if logged in, list its projects. */
export async function detectSupabaseCli() {
    const version = await runSupabase(["--version"], 15_000);
    if (version.code !== 0)
        return { status: "not-installed" };
    const list = await runSupabase(["projects", "list", "--output-format", "json"], 30_000);
    if (list.code !== 0) {
        if (/access token not provided|not logged in/i.test(list.stderr)) {
            return { status: "not-logged-in" };
        }
        return { status: "not-logged-in" };
    }
    try {
        return { status: "ready", projects: parseProjectsList(JSON.parse(list.stdout)) };
    }
    catch {
        return { status: "not-logged-in" };
    }
}
/** Fetch the project's privileged (service) key via the CLI. */
export async function getServiceKeyViaCli(ref) {
    const data = await runSupabaseJson([
        "projects",
        "api-keys",
        `--remote=${ref}`,
        "--reveal",
    ]);
    const key = pickServiceKey(parseApiKeys(data));
    if (!key) {
        throw new Error("No service/secret key found in `supabase projects api-keys` output. " +
            "Copy the service role key from the Supabase dashboard instead.");
    }
    return key;
}
/** Apply one SQL file to a remote project via the CLI. */
export async function applySqlFileViaCli(ref, filePath) {
    const r = await runSupabase(["db", "query", `--remote=${ref}`, "-f", filePath, "--yes"], 120_000);
    if (r.code !== 0) {
        throw new Error(`supabase db query failed for ${filePath}: ${r.stderr.trim().slice(0, 400)}`);
    }
}
//# sourceMappingURL=supabase-cli.js.map