import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCandidates } from "../src/extract.js";
import { cfg } from "./helpers/config.js";

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

const reply = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));

describe("extractCandidates", () => {
  it("keeps raw text as one inbox candidate when no LLM is configured", async () => {
    const out = await extractCandidates(cfg, "raw notes");
    assert.deepEqual(out, [{ title: "Unprocessed note", contentMd: "raw notes" }]);
  });

  let sentModel: string | undefined;
  it(
    "uses the configured extraction model",
    withFetch((async (_url: unknown, init?: RequestInit) => {
      sentModel = JSON.parse(String(init?.body)).model;
      return reply({ items: [{ title: "T", content: "C" }] });
    }) as typeof fetch, async () => {
      const out = await extractCandidates({ ...cfg, openaiApiKey: "k", extractModel: "my-model" }, "raw");
      assert.equal(sentModel, "my-model");
      assert.deepEqual(out, [{ title: "T", contentMd: "C" }]);
    }),
  );
});
