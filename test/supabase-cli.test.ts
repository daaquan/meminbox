import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseProjectsList,
  pickServiceKey,
  supabaseUrlForRef,
} from "../src/supabase-cli.js";

describe("parseProjectsList", () => {
  it("reads v3-style entries (id as ref)", () => {
    const projects = parseProjectsList([
      { id: "barlktqxhecnoadyjvat", name: "meminbox", region: "ap-northeast-1", status: "ACTIVE_HEALTHY" },
      { id: "abcdefghijklmnopqrst", name: "other", region: "us-east-1", status: "ACTIVE_HEALTHY" },
    ]);
    assert.equal(projects.length, 2);
    assert.deepEqual(projects[0], { ref: "barlktqxhecnoadyjvat", name: "meminbox" });
  });

  it("accepts ref-style entries and skips entries without an id", () => {
    const projects = parseProjectsList([
      { ref: "xyzref", name: "p" },
      { name: "no-id" },
      "junk",
    ]);
    assert.deepEqual(projects, [{ ref: "xyzref", name: "p" }]);
  });

  it("returns [] for non-arrays", () => {
    assert.deepEqual(parseProjectsList({}), []);
    assert.deepEqual(parseProjectsList(null), []);
  });
});

describe("pickServiceKey", () => {
  it("prefers the legacy service_role key over anon", () => {
    const key = pickServiceKey([
      { name: "anon", api_key: "anon-key" },
      { name: "service_role", api_key: "service-key" },
    ]);
    assert.equal(key, "service-key");
  });

  it("selects new-style secret keys and never publishable ones", () => {
    const key = pickServiceKey([
      { name: "default", type: "publishable", api_key: "sb_publishable_123" },
      { name: "default", type: "secret", api_key: "sb_secret_456" },
    ]);
    assert.equal(key, "sb_secret_456");
  });

  it("falls back to an sb_secret_ value when type is absent", () => {
    const key = pickServiceKey([{ name: "k", api_key: "sb_secret_789" }]);
    assert.equal(key, "sb_secret_789");
  });

  it("returns null when only anon/publishable keys exist", () => {
    assert.equal(pickServiceKey([{ name: "anon", api_key: "a" }]), null);
    assert.equal(
      pickServiceKey([{ name: "d", type: "publishable", api_key: "sb_publishable_x" }]),
      null,
    );
    assert.equal(pickServiceKey([]), null);
  });
});

describe("supabaseUrlForRef", () => {
  it("builds the project URL", () => {
    assert.equal(
      supabaseUrlForRef("barlktqxhecnoadyjvat"),
      "https://barlktqxhecnoadyjvat.supabase.co",
    );
  });
});
