import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineScores, contentHash, MemoryService } from "../src/memory.js";
import { cfg } from "./helpers/config.js";
import { fakeDb } from "./helpers/fake-db.js";

describe("MemoryService schema names", () => {
  it("only touches meminbox_* tables and functions", async () => {
    const { db, calls } = fakeDb(({ table, ops }) => {
      if (table === "meminbox_projects") return { data: { id: "p1" } };
      if (table === "meminbox_documents" && ops.some((o) => o.op === "insert")) {
        return { data: { id: "d1", title: "t", content_md: "c", status: "inbox" } };
      }
      return { data: [] };
    });
    const memory = new MemoryService(cfg, db);
    await memory.writeDocument({ title: "t", contentMd: "c" });
    await memory.search("q");
    const names = new Set(calls.map((c) => c.table ?? c.rpc));
    for (const n of names) assert.match(String(n), /^meminbox_/, `unprefixed: ${n}`);
  });
});

describe("combineScores", () => {
  it("never lowers a score when a second path also matches", () => {
    assert.ok(combineScores(1, 0.4) >= 1);
    assert.ok(combineScores(0.6, 0.5) > 0.6);
    assert.ok(combineScores(0.6, 0.5) > 0.5);
    assert.equal(combineScores(undefined, 0.7), 0.7);
    assert.equal(combineScores(0.7, undefined), 0.7);
  });
});

function searchDb(opts: { kw?: unknown[]; vec?: unknown[]; projectId?: string | null } = {}) {
  return fakeDb(({ table, rpc }) => {
    if (rpc === "meminbox_search_documents") return { data: opts.kw ?? [] };
    if (rpc === "meminbox_match_chunks") return { data: opts.vec ?? [] };
    if (table === "meminbox_projects") return { data: opts.projectId ? { id: opts.projectId } : null };
    return { data: [] };
  });
}

function withFetch(impl: typeof fetch, fn: () => Promise<void>) {
  return async () => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
  };
}

const embedOk = (async () =>
  new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.01) }] }))) as typeof fetch;

describe("MemoryService.search", () => {
  it(
    "keeps one entry per document and ranks a two-path match above its parts",
    withFetch(embedOk, async () => {
      const { db } = searchDb({
        kw: [
          { id: "A", title: "A", content_md: "a", rank: 0.8 },
          { id: "B", title: "B", content_md: "b", rank: 0.6 },
        ],
        vec: [
          { document_id: "B", title: "B", chunk: "b1", similarity: 0.9 },
          { document_id: "B", title: "B", chunk: "b2", similarity: 0.2 },
        ],
      });
      const hits = await new MemoryService({ ...cfg, openaiApiKey: "k" }, db).search("q");
      const b = hits.find((h) => h.documentId === "B")!;
      assert.deepEqual(b.via, ["keyword", "vector"]);
      assert.equal(b.snippet, "b1");
      // keyword-only 0.75 (0.6/0.8) and vector 0.9: the combination beats both
      assert.ok(b.score > 0.9, `score ${b.score}`);
      assert.equal(hits.length, 2);
    }),
  );

  it(
    "falls back to keyword results when the embedding API fails",
    withFetch((async () => new Response("rate limited", { status: 429 })) as typeof fetch, async () => {
      const { db, calls } = searchDb({ kw: [{ id: "A", title: "A", content_md: "a", rank: 0.5 }] });
      const hits = await new MemoryService({ ...cfg, openaiApiKey: "k" }, db).search("q");
      assert.deepEqual(hits.map((h) => h.documentId), ["A"]);
      assert.ok(!calls.some((c) => c.rpc === "meminbox_match_chunks"));
    }),
  );

  it("passes the project id to both search functions", withFetch(embedOk, async () => {
    const { db, calls } = searchDb({ projectId: "P1" });
    await new MemoryService({ ...cfg, openaiApiKey: "k" }, db).search("q", { projectSlug: "work" });
    for (const name of ["meminbox_search_documents", "meminbox_match_chunks"]) {
      const c = calls.find((x) => x.rpc === name)!;
      assert.equal((c.args[0] as { p_project_id: string }).p_project_id, "P1");
    }
  }));

  it("returns nothing for an unknown project without creating it", async () => {
    const { db, calls } = searchDb({ projectId: null });
    const hits = await new MemoryService(cfg, db).search("q", { projectSlug: "nope" });
    assert.deepEqual(hits, []);
    assert.ok(!calls.some((c) => c.op === "upsert" || c.rpc));
  });
});

describe("MemoryService.writeDocument", () => {
  it(
    "does not throw when indexing fails after the insert, and audits the failure",
    withFetch((async () => new Response("down", { status: 503 })) as typeof fetch, async () => {
      const { db, calls } = fakeDb(({ table, ops }) => {
        if (table === "meminbox_projects") return { data: { id: "p1" } };
        if (table === "meminbox_documents" && ops.some((o) => o.op === "insert")) {
          return { data: { id: "d1", title: "t", content_md: "c", status: "inbox" } };
        }
        return { data: null };
      });
      const doc = await new MemoryService({ ...cfg, openaiApiKey: "k" }, db).writeDocument({
        title: "t",
        contentMd: "c",
      });
      assert.equal(doc.id, "d1");
      assert.match(doc.indexError ?? "", /503/);
      const audit = calls.find((c) => c.table === "meminbox_audit_log" && c.op === "insert")!;
      assert.match(JSON.stringify(audit.args[0]), /indexError/);
      assert.equal(calls.filter((c) => c.table === "meminbox_documents" && c.op === "insert").length, 1);
    }),
  );
});

describe("MemoryService.reindexAll", () => {
  it("pages through every document instead of stopping at a fixed limit", async () => {
    const page = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `d${offset + i}`, title: "t", content_md: "" }));
    const { db, calls } = fakeDb(({ table, ops }) => {
      const range = ops.find((o) => o.op === "range");
      if (table === "meminbox_documents" && range) {
        const from = range.args[0] as number;
        return { data: from === 0 ? page(500, 0) : from === 500 ? page(500, 500) : page(3, 1000) };
      }
      return { data: null };
    });
    const n = await new MemoryService(cfg, db).reindexAll();
    assert.equal(n, 1003);
    assert.equal(calls.filter((c) => c.op === "range").length, 3);
  });
});

describe("contentHash", () => {
  it("ignores CRLF and surrounding whitespace but not inner changes", () => {
    assert.equal(contentHash("a\r\nb\n"), contentHash("  a\nb"));
    assert.notEqual(contentHash("a b"), contentHash("a  b"));
    assert.match(contentHash("x"), /^[0-9a-f]{64}$/);
  });
});

describe("MemoryService.writeDocument deduplication", () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: "d1",
    title: "t",
    content_md: "c",
    content_hash: contentHash("c"),
    status: "active",
    version: 1,
    source_key: null,
    ...over,
  });
  type Ops = Array<{ op: string; args: unknown[] }>;
  const has = (ops: Ops, op: string, ...args: unknown[]) =>
    ops.some((o) => o.op === op && args.every((a, i) => o.args[i] === a));

  it("returns identical existing content instead of inserting a copy", async () => {
    const { db, calls } = fakeDb(({ table, ops }) => {
      if (table === "meminbox_projects") return { data: { id: "p1" } };
      if (table === "meminbox_documents" && has(ops, "eq", "content_hash")) return { data: [stored()] };
      return { data: null };
    });
    const doc = await new MemoryService(cfg, db).writeDocument({ title: "other title", contentMd: "\nc\n" });
    assert.equal(doc.outcome, "duplicate");
    assert.equal(doc.id, "d1");
    assert.ok(!calls.some((c) => c.op === "insert"));
    const check = calls.find((c) => c.op === "neq")!;
    assert.deepEqual(check.args, ["status", "archived"]);
  });

  it("inserts new content with its hash and source key", async () => {
    const { db, calls } = fakeDb(({ table, ops }) => {
      if (table === "meminbox_projects") return { data: { id: "p1" } };
      if (table === "meminbox_documents" && has(ops, "insert")) return { data: stored({ status: "inbox" }) };
      return { data: null };
    });
    const doc = await new MemoryService(cfg, db).writeDocument({ title: "t", contentMd: "c", sourceKey: "k1" });
    assert.equal(doc.outcome, "created");
    const row = calls.find((c) => c.op === "insert" && c.table === "meminbox_documents")!.args[0] as Record<string, unknown>;
    assert.equal(row.content_hash, contentHash("c"));
    assert.equal(row.source_key, "k1");
  });

  it("leaves a source-keyed document alone when nothing changed", async () => {
    const { db, calls } = fakeDb(({ table, ops }) => {
      if (table === "meminbox_projects") return { data: { id: "p1" } };
      if (has(ops, "eq", "source_key", "k1")) return { data: stored({ source_key: "k1" }) };
      return { data: null };
    });
    const doc = await new MemoryService(cfg, db).writeDocument({ title: "t", contentMd: "c", sourceKey: "k1" });
    assert.equal(doc.outcome, "unchanged");
    assert.ok(!calls.some((c) => ["insert", "update"].includes(c.op) && c.table === "meminbox_documents"));
  });

  it("updates a changed source in place, bumps the version and sends it back to the inbox", async () => {
    const { db, calls } = fakeDb(({ table, ops }) => {
      if (table === "meminbox_projects") return { data: { id: "p1" } };
      if (table === "meminbox_documents" && has(ops, "update")) {
        return { data: stored({ content_md: "new", status: "inbox", version: 2, source_key: "k1" }) };
      }
      if (has(ops, "eq", "source_key", "k1")) return { data: stored({ source_key: "k1" }) };
      return { data: null };
    });
    const doc = await new MemoryService(cfg, db).writeDocument({ title: "t", contentMd: "new", sourceKey: "k1" });
    assert.equal(doc.outcome, "updated");
    const upd = calls.find((c) => c.op === "update")!.args[0] as Record<string, unknown>;
    assert.equal(upd.version, 2);
    assert.equal(upd.status, "inbox");
    assert.equal(upd.content_hash, contentHash("new"));
    assert.ok(!calls.some((c) => c.op === "insert" && c.table === "meminbox_documents"));
    assert.ok(calls.some((c) => c.table === "meminbox_audit_log" && JSON.stringify(c.args).includes("update")));
  });

  it("never resurrects a document a human archived", async () => {
    const { db, calls } = fakeDb(({ table, ops }) => {
      if (table === "meminbox_projects") return { data: { id: "p1" } };
      if (has(ops, "eq", "source_key", "k1")) return { data: stored({ source_key: "k1", status: "archived" }) };
      return { data: null };
    });
    const doc = await new MemoryService(cfg, db).writeDocument({ title: "t", contentMd: "changed", sourceKey: "k1" });
    assert.equal(doc.outcome, "archived");
    assert.ok(!calls.some((c) => ["insert", "update"].includes(c.op) && c.table === "meminbox_documents"));
  });
});
