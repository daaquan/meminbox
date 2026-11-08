import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/**
 * `meminbox configure-agent` — register the meminbox MCP server with an
 * agent client.
 *
 * The generated entries contain NO secrets: the server reads
 * ~/.meminbox/.env itself. The only per-client setting is MEMINBOX_ACTOR,
 * which is what makes provenance say "claude-code wrote this".
 */

export type AgentTool = "claude-code" | "codex" | "cursor" | "claude-desktop";

export const AGENT_TOOLS: AgentTool[] = [
  "claude-code",
  "codex",
  "cursor",
  "claude-desktop",
];

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function mcpServerEntry(actor: string): McpServerEntry {
  return { command: "meminbox-mcp", args: [], env: { MEMINBOX_ACTOR: actor } };
}

/** Merge the meminbox entry into an MCP JSON config (pure; unit-tested). */
export function mergeMcpJson(
  existingText: string | null,
  entry: McpServerEntry,
): string {
  const root = existingText ? (JSON.parse(existingText) as Record<string, unknown>) : {};
  const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
  servers.meminbox = entry;
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + "\n";
}

export function codexTomlBlock(actor: string): string {
  return [
    "[mcp_servers.meminbox]",
    'command = "meminbox-mcp"',
    "args = []",
    "",
    "[mcp_servers.meminbox.env]",
    `MEMINBOX_ACTOR = "${actor}"`,
    "",
  ].join("\n");
}

/** Insert or replace the meminbox section in Codex's config.toml (pure). */
export function upsertCodexToml(existingText: string, actor: string): string {
  const lines = existingText.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      skipping =
        header[1] === "mcp_servers.meminbox" ||
        header[1] === "mcp_servers.meminbox.env";
    }
    if (!skipping) kept.push(line);
  }
  const base = kept.join("\n").replace(/\n+$/, "");
  return (base ? base + "\n\n" : "") + codexTomlBlock(actor);
}

export function agentConfigPath(tool: AgentTool): string {
  const home = homedir();
  switch (tool) {
    case "claude-code":
      return join(home, ".claude.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "codex":
      return join(home, ".codex", "config.toml");
    case "claude-desktop": {
      if (platform() === "darwin") {
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (platform() === "win32") {
        return join(process.env.APPDATA ?? home, "Claude", "claude_desktop_config.json");
      }
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    }
  }
}

function onPath(bin: string): boolean {
  const exts = platform() === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const ext of exts) {
      if (dir && existsSync(join(dir, bin + ext))) return true;
    }
  }
  return false;
}

export function runConfigureAgent(argv: string[]): void {
  const toolIdx = argv.indexOf("--tool");
  const tool = toolIdx >= 0 ? argv[toolIdx + 1] : undefined;
  if (!tool || !AGENT_TOOLS.includes(tool as AgentTool)) {
    throw new Error(
      `usage: meminbox configure-agent --tool <${AGENT_TOOLS.join("|")}> [--print]`,
    );
  }
  const printOnly = argv.includes("--print");
  const actorIdx = argv.indexOf("--actor");
  const actor = actorIdx >= 0 ? argv[actorIdx + 1]! : tool;
  const path = agentConfigPath(tool as AgentTool);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;

  const next =
    tool === "codex"
      ? upsertCodexToml(existing ?? "", actor)
      : mergeMcpJson(existing, mcpServerEntry(actor));

  if (printOnly) {
    console.log(`# ${path}\n`);
    console.log(next);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existing !== null) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, next);
  console.log(`configured ${tool}: meminbox MCP server written to ${path}`);
  if (existing !== null) console.log(`previous config backed up to ${path}.bak`);
  if (!onPath("meminbox-mcp")) {
    console.log(
      "note: `meminbox-mcp` is not on your PATH yet. Install meminbox globally first:\n" +
        "  npm install -g github:daaquan/meminbox",
    );
  }
  console.log("restart the agent client to pick up the new MCP server.");
}
