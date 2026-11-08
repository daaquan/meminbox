import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mcpServerEntry,
  mergeMcpJson,
  upsertCodexToml,
} from "../src/agents.js";

describe("mergeMcpJson", () => {
  it("creates a fresh config with the meminbox entry", () => {
    const out = JSON.parse(mergeMcpJson(null, mcpServerEntry("claude-code")));
    assert.equal(out.mcpServers.meminbox.command, "meminbox-mcp");
    assert.equal(out.mcpServers.meminbox.env.MEMINBOX_ACTOR, "claude-code");
  });

  it("preserves other servers and replaces an old meminbox entry", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: "other-mcp", args: [], env: {} },
        meminbox: { command: "old", args: [], env: {} },
      },
    });
    const out = JSON.parse(mergeMcpJson(existing, mcpServerEntry("cursor")));
    assert.equal(out.mcpServers.other.command, "other-mcp");
    assert.equal(out.mcpServers.meminbox.command, "meminbox-mcp");
    assert.equal(out.mcpServers.meminbox.env.MEMINBOX_ACTOR, "cursor");
  });
});

describe("upsertCodexToml", () => {
  it("appends a meminbox section to an empty config", () => {
    const out = upsertCodexToml("", "codex");
    assert.ok(out.includes("[mcp_servers.meminbox]"));
    assert.ok(out.includes('MEMINBOX_ACTOR = "codex"'));
  });

  it("replaces an existing meminbox section without duplicating it", () => {
    const once = upsertCodexToml('model = "gpt-5"\n', "codex");
    const twice = upsertCodexToml(once, "codex");
    assert.equal(twice.match(/\[mcp_servers\.meminbox\]/g)?.length, 1);
    assert.ok(twice.includes('model = "gpt-5"'));
  });
});
