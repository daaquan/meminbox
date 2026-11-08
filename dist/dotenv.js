import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** Directory holding the user's meminbox configuration (~/.meminbox). */
export function meminboxHome() {
    return process.env.MEMINBOX_HOME || join(homedir(), ".meminbox");
}
export function meminboxEnvPath() {
    return join(meminboxHome(), ".env");
}
/**
 * Minimal .env parser: KEY=value lines, `#` comments, optional quotes.
 * Deliberately tiny — the file format we write in `init` is our own.
 */
export function parseDotEnv(text) {
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}
/**
 * Load configuration files into process.env WITHOUT overriding variables
 * that are already set. Lookup order:
 *   1. ~/.meminbox/.env  (written by `meminbox init` — the normal case)
 *   2. ./.env            (project-local, for development)
 * Real environment variables always win over both files.
 */
export function loadEnvFiles() {
    for (const path of [meminboxEnvPath(), join(process.cwd(), ".env")]) {
        if (!existsSync(path))
            continue;
        const parsed = parseDotEnv(readFileSync(path, "utf8"));
        for (const [key, value] of Object.entries(parsed)) {
            if (process.env[key] === undefined)
                process.env[key] = value;
        }
    }
}
/** Serialise values back to .env text (used by `init`). */
export function formatDotEnv(values) {
    const lines = [
        "# meminbox configuration — written by `meminbox init`.",
        "# Contains secrets (service role key). Keep this file private (mode 0600).",
        "",
    ];
    for (const [key, value] of Object.entries(values)) {
        lines.push(`${key}=${value}`);
    }
    return lines.join("\n") + "\n";
}
//# sourceMappingURL=dotenv.js.map