import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkMarkdown } from "../src/chunk.js";

describe("chunkMarkdown", () => {
  it("returns no chunks for empty input", () => {
    assert.deepEqual(chunkMarkdown(""), []);
    assert.deepEqual(chunkMarkdown("  \n\n  "), []);
  });

  it("packs paragraphs up to maxChars", () => {
    const md = "alpha\n\nbeta\n\ngamma";
    const chunks = chunkMarkdown(md, { maxChars: 12 });
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(c.length <= 12 + 4, `chunk too long: ${c}`);
  });

  it("hard-splits oversized paragraphs with overlap", () => {
    const md = "x".repeat(100);
    const chunks = chunkMarkdown(md, { maxChars: 30, overlap: 5 });
    assert.ok(chunks.length >= 4);
    assert.equal(chunks[0]?.length, 30);
    // every character of the original survives in some chunk
    const joined = chunks.join("");
    assert.ok(joined.length >= 100);
  });

  it("keeps headings attached to following content", () => {
    const md = "# Title\n\nbody one\n\n## Section\n\nbody two";
    const chunks = chunkMarkdown(md, { maxChars: 1000 });
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0]!.includes("## Section"));
  });
});

describe("chunkMarkdown edge cases", () => {
  it("rejects an overlap that could never advance", () => {
    assert.throws(() => chunkMarkdown("x".repeat(50), { maxChars: 10, overlap: 10 }), /overlap/);
    assert.throws(() => chunkMarkdown("x".repeat(50), { maxChars: 10, overlap: 20 }), /overlap/);
  });

  it("never splits a surrogate pair", () => {
    const md = "😀".repeat(40); // 80 UTF-16 code units, no break points
    const chunks = chunkMarkdown(md, { maxChars: 15, overlap: 3 });
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c), `lone surrogate in ${JSON.stringify(c)}`);
    }
  });
});
