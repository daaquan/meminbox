import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDotEnv, formatDotEnv } from "../src/dotenv.js";

describe("parseDotEnv", () => {
  it("parses key=value pairs, comments and blank lines", () => {
    const parsed = parseDotEnv(
      "# comment\n\nSUPABASE_URL=https://x.supabase.co\nEMPTY=\nMEMORY_ACTOR=cli\n",
    );
    assert.equal(parsed.SUPABASE_URL, "https://x.supabase.co");
    assert.equal(parsed.EMPTY, "");
    assert.equal(parsed.MEMORY_ACTOR, "cli");
  });

  it("strips surrounding quotes and keeps '=' inside values", () => {
    const parsed = parseDotEnv('A="a=b"\nB=\'c\'\n');
    assert.equal(parsed.A, "a=b");
    assert.equal(parsed.B, "c");
  });

  it("round-trips through formatDotEnv", () => {
    const values = { SUPABASE_URL: "https://x.supabase.co", MEMORY_ACTOR: "codex" };
    const parsed = parseDotEnv(formatDotEnv(values));
    assert.deepEqual(parsed, values);
  });
});
