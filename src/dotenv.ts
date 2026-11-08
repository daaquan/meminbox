import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory holding the user's meminbox configuration (~/.meminbox). */
export function meminboxHome(): string {
  return process.env.MEMINBOX_HOME || join(homedir(), ".meminbox");
}

export function meminboxEnvPath(): string {
  return join(meminboxHome(), ".env");
}

/**
 * Minimal .env parser: KEY=value lines, `#` comments, optional quotes.
 * Deliberately tiny — the file format we write in `init` is our own.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface ConfigFiles {
  /** ~/.meminbox/.env — written by `meminbox init`, owned by meminbox. */
  home: Record<string, string>;
  /** ./.env of the current directory — usually some OTHER project's file. */
  local: Record<string, string>;
}

/**
 * Read the configuration files WITHOUT touching process.env (config.ts
 * decides which keys from which file are trusted).
 */
export function readConfigFiles(cwd: string = process.cwd()): ConfigFiles {
  const read = (path: string) =>
    existsSync(path) ? parseDotEnv(readFileSync(path, "utf8")) : {};
  return { home: read(meminboxEnvPath()), local: read(join(cwd, ".env")) };
}

/**
 * Write a secrets file readable only by the owner. writeFileSync's `mode`
 * applies only when the file is created, so an existing file (or
 * directory) with looser permissions is tightened explicitly.
 */
export function writePrivateFile(path: string, dir: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Serialise values back to .env text (used by `init`). */
export function formatDotEnv(values: Record<string, string>): string {
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
