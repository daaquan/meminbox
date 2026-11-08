import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { writePrivateFile, type ConfigFiles } from "../src/dotenv.js";

const none: ConfigFiles = { home: {}, local: {} };

describe("loadConfig", () => {
  it("ignores generic SUPABASE_*/OPENAI_* names in the shell environment", () => {
    const env = {
      SUPABASE_URL: "https://app.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "app-key",
      OPENAI_API_KEY: "sk-app",
    };
    const files = { home: { MEMINBOX_SUPABASE_URL: "https://mem.supabase.co", MEMINBOX_SUPABASE_SERVICE_ROLE_KEY: "mem-key" }, local: {} };
    const cfg = loadConfig(env, files);
    assert.equal(cfg.supabaseUrl, "https://mem.supabase.co");
    assert.equal(cfg.supabaseServiceRoleKey, "mem-key");
    assert.equal(cfg.openaiApiKey, null);
  });

  it("never takes unprefixed keys from the current directory's .env", () => {
    const files = {
      home: { MEMINBOX_SUPABASE_URL: "https://mem.supabase.co", MEMINBOX_SUPABASE_SERVICE_ROLE_KEY: "k" },
      local: { OPENAI_API_KEY: "sk-other-project", EMBEDDING_MODEL: "x" },
    };
    const cfg = loadConfig({}, files);
    assert.equal(cfg.openaiApiKey, null);
    assert.equal(cfg.embeddingModel, "text-embedding-3-small");
  });

  it("still reads a 0.3 ~/.meminbox/.env with unprefixed names", () => {
    const cfg = loadConfig({}, {
      home: { SUPABASE_URL: "https://old.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", MEMORY_ACTOR: "cli", MEMORY_DEFAULT_PROJECT: "work" },
      local: {},
    });
    assert.equal(cfg.supabaseUrl, "https://old.supabase.co");
    assert.equal(cfg.defaultProject, "work");
  });

  it("lets MEMINBOX_* in the environment override files, and honours 0.3 MEMORY_ACTOR", () => {
    const files = { home: { MEMINBOX_SUPABASE_URL: "https://file.supabase.co", MEMINBOX_SUPABASE_SERVICE_ROLE_KEY: "k", MEMINBOX_ACTOR: "cli" }, local: {} };
    const cfg = loadConfig({ MEMINBOX_SUPABASE_URL: "https://env.supabase.co", MEMORY_ACTOR: "codex" }, files);
    assert.equal(cfg.supabaseUrl, "https://env.supabase.co");
    assert.equal(cfg.actor, "codex");
  });

  it("reports the prefixed name when a required setting is missing", () => {
    assert.throws(() => loadConfig({}, none), /MEMINBOX_SUPABASE_URL/);
  });
});

describe("writePrivateFile", () => {
  it("tightens an existing file and directory to 0600 / 0700", () => {
    const dir = mkdtempSync(join(tmpdir(), "meminbox-"));
    const path = join(dir, ".env");
    writeFileSync(path, "old", { mode: 0o644 });
    writePrivateFile(path, dir, "new");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

describe("allowAgentPromote", () => {
  const base = { MEMINBOX_SUPABASE_URL: "https://m.supabase.co", MEMINBOX_SUPABASE_SERVICE_ROLE_KEY: "k" };
  it("is off unless MEMINBOX_ALLOW_AGENT_PROMOTE is set", () => {
    assert.equal(loadConfig(base, none).allowAgentPromote, false);
    assert.equal(loadConfig({ ...base, MEMINBOX_ALLOW_AGENT_PROMOTE: "1" }, none).allowAgentPromote, true);
    assert.equal(loadConfig({ ...base, MEMINBOX_ALLOW_AGENT_PROMOTE: "0" }, none).allowAgentPromote, false);
  });

  it("cannot be enabled by the current directory's .env", () => {
    const files = { home: {}, local: { MEMINBOX_ALLOW_AGENT_PROMOTE: "1" } };
    assert.equal(loadConfig(base, files).allowAgentPromote, false);
    const home = { home: { MEMINBOX_ALLOW_AGENT_PROMOTE: "1" }, local: {} };
    assert.equal(loadConfig(base, home).allowAgentPromote, true);
  });
});
