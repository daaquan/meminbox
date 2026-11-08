import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  claudeProjectSlug,
  collectDir,
  collectSources,
  detectSecret,
  encodeClaudePath,
  geminiMemories,
  parseFrontmatter,
  resolveEncodedPath,
} from "../src/importers.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "meminbox-import-"));
}
function put(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("detectSecret", () => {
  it("flags common credential shapes and names only the kind", () => {
    assert.equal(detectSecret("key: sk-proj-abcdefghijklmnopqrstuvwx"), "OpenAI/Anthropic-style API key");
    assert.equal(detectSecret("AKIAABCDEFGHIJKLMNOP"), "AWS access key");
    assert.equal(detectSecret('API_KEY="abcd1234abcd1234abcd"'), "credential assignment");
    assert.equal(detectSecret("-----BEGIN OPENSSH PRIVATE KEY-----"), "private key");
  });
  it("does not flag prose about keys", () => {
    assert.equal(detectSecret("The GMO API keys live in 1Password, not in this repo."), null);
    assert.equal(detectSecret("password: see vault"), null);
  });
});

describe("parseFrontmatter / geminiMemories", () => {
  it("reads simple frontmatter", () => {
    const fm = parseFrontmatter("---\nname: dev-env\ndescription: \"Node 22\"\n---\nbody");
    assert.equal(fm.name, "dev-env");
    assert.equal(fm.description, "Node 22");
    assert.deepEqual(parseFrontmatter("no frontmatter"), {});
  });
  it("extracts only the Gemini Added Memories section", () => {
    const md = "# Rules\nbe nice\n\n## Gemini Added Memories\n- likes tea\n- uses zsh\n\n## Other\nx";
    assert.equal(geminiMemories(md), "- likes tea\n- uses zsh");
    assert.equal(geminiMemories("# nothing"), null);
  });
});

describe("Claude Code project slugs", () => {
  it("resolves a lossy encoded path back to the real directory", () => {
    const root = tmp();
    mkdirSync(join(root, "work", "my.app", "sub-dir"), { recursive: true });
    const encoded = encodeClaudePath(join(root, "work", "my.app", "sub-dir"));
    assert.equal(resolveEncodedPath(encoded), join(root, "work", "my.app", "sub-dir"));
    assert.equal(resolveEncodedPath(`${encoded}-gone`), null);
  });
  it("uses the repo basename, folds worktrees, and maps home to the default project", () => {
    const root = tmp();
    const home = join(root, "home");
    mkdirSync(join(home, "trade-ui", ".claude", "worktrees", "wt1"), { recursive: true });
    assert.equal(claudeProjectSlug("/nope", encodeClaudePath(join(home, "trade-ui")), home), "trade-ui");
    assert.equal(
      claudeProjectSlug("/nope", encodeClaudePath(join(home, "trade-ui", ".claude", "worktrees", "wt1")), home),
      "trade-ui",
    );
    assert.equal(claudeProjectSlug("/nope", encodeClaudePath(home), home), undefined);
  });
  it("falls back to the cwd in a session transcript when the directory is gone", () => {
    const root = tmp();
    const projectDir = join(root, "-gone-path-proj");
    put(join(projectDir, "s.jsonl"), JSON.stringify({ type: "user", cwd: "/gone/path/proj" }) + "\n");
    assert.equal(claudeProjectSlug(projectDir, "-gone-path-proj", "/home/x"), "proj");
  });
});

describe("collectSources", () => {
  it("collects Claude Code, Codex and Gemini memory with stable source keys", () => {
    const home = tmp();
    const proj = join(home, ".claude", "projects", "-gone-repo");
    put(join(proj, "memory", "MEMORY.md"), "- [x](x.md)");
    put(join(proj, "memory", "dev-env.md"), "---\nname: dev-env\n---\nUse Node 22.");
    put(join(proj, "memory", "keys.md"), "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    put(join(home, ".codex", "memories", "rollout_summaries", "a.md"), "# Deploy notes\nstaging first");
    put(join(home, ".gemini", "GEMINI.md"), "## Gemini Added Memories\n- likes tea\n");

    const r = collectSources(["claude-code", "codex", "gemini"], { home, env: {} });
    assert.deepEqual(
      r.items.map((i) => [i.agent, i.sourceKey, i.title]),
      [
        ["claude-code", "claude-code:-gone-repo/dev-env.md", "dev-env"],
        ["codex", "codex:memories/rollout_summaries/a.md", "Deploy notes"],
        ["gemini-cli", "gemini:GEMINI.md#gemini-added-memories", "Gemini CLI memories"],
      ],
    );
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0]!.reason, /GitHub token/);
    assert.ok(!r.skipped[0]!.reason.includes("ghp_"));

    const allowed = collectSources(["claude-code"], { home, env: {}, allowSecrets: true });
    assert.equal(allowed.items.length, 2);
  });

  it("respects CODEX_HOME and reports missing sources instead of failing", () => {
    const home = tmp();
    const codexHome = join(home, "custom-codex");
    put(join(codexHome, "memories", "m.md"), "remember this");
    const r = collectSources(["claude-code", "codex", "gemini"], { home, env: { CODEX_HOME: codexHome } });
    assert.deepEqual(r.items.map((i) => i.sourceKey), ["codex:memories/m.md"]);
    assert.equal(r.notes.length, 2);
  });

  it("rejects unknown sources", () => {
    assert.throws(() => collectSources(["nope"]), /Unknown import source/);
  });
});

describe("collectDir", () => {
  it("imports Markdown recursively, skipping hidden dirs and node_modules", () => {
    const root = tmp();
    put(join(root, "a.md"), "# A\nx");
    put(join(root, "rules", "b.mdc"), "---\ndescription: b\n---\ny");
    put(join(root, ".git", "c.md"), "z");
    put(join(root, "node_modules", "d.md"), "z");
    put(join(root, "e.txt"), "z");
    const r = collectDir(root, "cursor");
    assert.deepEqual(r.items.map((i) => i.title), ["A", "rules/b"]);
    assert.ok(r.items.every((i) => i.agent === "cursor" && i.sourceKey.startsWith("dir:")));
  });
});
