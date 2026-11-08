import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { friendlyError, SetupCancelled } from "../src/errors.js";

describe("friendlyError", () => {
  it("shows only the first line of a long error, never a stack", () => {
    const err = new Error("boom happened\n    at somewhere (file.js:1:1)");
    const out = friendlyError(err);
    assert.equal(out, "boom happened");
    assert.ok(!out.includes("at somewhere"));
  });

  it("adds an anon-key hint for RLS failures", () => {
    const out = friendlyError(
      new Error('ensureProject failed: new row violates row-level security policy for table "projects"'),
    );
    assert.match(out, /row-level security/);
    assert.match(out, /service role/);
  });

  it("passes SetupCancelled messages through untouched", () => {
    const out = friendlyError(new SetupCancelled("Setup cancelled — kept."));
    assert.equal(out, "Setup cancelled — kept.");
  });

  it("handles non-Error values", () => {
    assert.equal(friendlyError("plain failure"), "plain failure");
  });
});
