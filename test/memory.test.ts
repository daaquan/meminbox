import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Config } from "../src/config.js";
import { MemoryService } from "../src/memory.js";
import { fakeDb } from "./helpers/fake-db.js";

export const cfg: Config = {
  supabaseUrl: "https://x.supabase.co",
  supabaseServiceRoleKey: "sb_secret_x",
  openaiApiKey: null,
  embeddingModel: "text-embedding-3-small",
  embeddingDims: 1536,
  defaultProject: "default",
  actor: "test",
};

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
