import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryService } from "../src/memory.js";
import { createMcpServer } from "../src/mcp/tools.js";
import { cfg } from "./helpers/config.js";
import { fakeDb } from "./helpers/fake-db.js";

async function connect(allowAgentPromote: boolean) {
  const { db, calls } = fakeDb(({ table, ops }) => {
    if (table === "meminbox_projects") return { data: { id: "p1" } };
    if (table === "meminbox_documents" && ops.some((o) => o.op === "insert")) {
      const row = ops.find((o) => o.op === "insert")!.args[0] as Record<string, unknown>;
      return { data: { id: "d1", title: row.title, content_md: row.content_md, status: row.status } };
    }
    return { data: null };
  });
  const c = { ...cfg, allowAgentPromote };
  const server = createMcpServer(c, new MemoryService(c, db), "9.9.9");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls };
}

describe("MCP inbox gate", () => {
  it("does not offer memory_promote to agents by default", async () => {
    const { client } = await connect(false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("memory_write"));
    assert.ok(!names.includes("memory_promote"));
  });

  it("rejects agent writes straight to active memory by default", async () => {
    const { client, calls } = await connect(false);
    const res = await client.callTool({
      name: "memory_write",
      arguments: { title: "t", content: "c", status: "active" },
    });
    assert.equal(res.isError, true);
    assert.ok(!calls.some((c) => c.table === "meminbox_documents" && c.op === "insert"));
  });

  it("files agent writes in the inbox", async () => {
    const { client } = await connect(false);
    const res = await client.callTool({ name: "memory_write", arguments: { title: "t", content: "c" } });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    assert.equal(body.status, "inbox");
  });

  it("offers promote and active writes when MEMINBOX_ALLOW_AGENT_PROMOTE is set", async () => {
    const { client } = await connect(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("memory_promote"));
    const res = await client.callTool({
      name: "memory_write",
      arguments: { title: "t", content: "c", status: "active" },
    });
    assert.notEqual(res.isError, true);
  });

  it("reports the package version", async () => {
    const { client } = await connect(false);
    assert.equal(client.getServerVersion()?.version, "9.9.9");
  });
});
