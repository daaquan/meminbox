import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifySupabaseKey,
  interpretProjectsListResult,
  parseProjectsList,
  pickServiceKey,
  refFromSupabaseUrl,
  supabaseUrlForRef,
} from "../src/supabase-cli.js";

describe("parseProjectsList", () => {
  it("reads v3-style entries (id as ref)", () => {
    const projects = parseProjectsList([
      { id: "barlktqxhecnoadyjvat", name: "meminbox", region: "ap-northeast-1", status: "ACTIVE_HEALTHY" },
      { id: "abcdefghijklmnopqrst", name: "other", region: "us-east-1", status: "ACTIVE_HEALTHY" },
    ]);
    assert.equal(projects.length, 2);
    assert.deepEqual(projects[0], { ref: "barlktqxhecnoadyjvat", name: "meminbox", linked: false });
  });

  it("accepts ref-style entries and skips entries without an id", () => {
    const projects = parseProjectsList([
      { ref: "xyzref", name: "p" },
      { name: "no-id" },
      "junk",
    ]);
    assert.deepEqual(projects, [{ ref: "xyzref", name: "p", linked: false }]);
  });

  it("keeps the linked flag so init can reuse `supabase link`", () => {
    const projects = parseProjectsList([
      { id: "abcdefghijklmnopqrst", name: "other" },
      { id: "barlktqxhecnoadyjvat", name: "linked one", linked: true },
    ]);
    assert.equal(projects.find((p) => p.linked)?.ref, "barlktqxhecnoadyjvat");
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

describe("refFromSupabaseUrl", () => {
  it("round-trips supabaseUrlForRef", () => {
    assert.equal(refFromSupabaseUrl(supabaseUrlForRef("barlktqxhecnoadyjvat")), "barlktqxhecnoadyjvat");
    assert.equal(refFromSupabaseUrl("https://barlktqxhecnoadyjvat.supabase.co/"), "barlktqxhecnoadyjvat");
  });

  it("returns null for custom domains", () => {
    assert.equal(refFromSupabaseUrl("https://db.example.com"), null);
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

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("interpretProjectsListResult", () => {
  it("maps the access-token error to not-logged-in", () => {
    const det = interpretProjectsListResult(1, "", "Access token not provided. Supply an access token by running `supabase login`");
    assert.equal(det.status, "not-logged-in");
  });

  it("keeps unknown failures visible as errors, never as not-logged-in", () => {
    const det = interpretProjectsListResult(1, "", "lookup api.supabase.com: no such host");
    assert.equal(det.status, "error");
    if (det.status === "error") assert.match(det.detail, /no such host/);
  });

  it("parses a successful listing", () => {
    const det = interpretProjectsListResult(
      0,
      JSON.stringify([{ id: "barlktqxhecnoadyjvat", name: "p", linked: true }]),
      "",
    );
    assert.equal(det.status, "ready");
    if (det.status === "ready") assert.equal(det.projects[0]?.linked, true);
  });

  it("reports non-JSON success output as an error with the output attached", () => {
    const det = interpretProjectsListResult(0, "not json at all", "");
    assert.equal(det.status, "error");
  });
});

describe("classifySupabaseKey", () => {
  it("recognises new-style secret and publishable keys by prefix", () => {
    assert.equal(classifySupabaseKey("sb_secret_abc123"), "service");
    assert.equal(classifySupabaseKey("sb_publishable_abc123"), "anon");
  });

  it("reads the role claim of legacy JWT keys", () => {
    assert.equal(
      classifySupabaseKey(fakeJwt({ role: "service_role", ref: "x" })),
      "service",
    );
    assert.equal(classifySupabaseKey(fakeJwt({ role: "anon", ref: "x" })), "anon");
  });

  it("returns unknown for anything else", () => {
    assert.equal(classifySupabaseKey("not-a-key"), "unknown");
    assert.equal(classifySupabaseKey(fakeJwt({ sub: "123" })), "unknown");
  });
});
