/**
 * Split Markdown into chunks for the derived vector index.
 *
 * Rules (kept deliberately simple and deterministic):
 * - Split on heading boundaries first, then on blank lines.
 * - Greedily pack paragraphs up to `maxChars`.
 * - A single oversized paragraph is hard-split with `overlap` characters
 *   carried into the next chunk.
 * The document itself is never modified — chunks are disposable.
 */
export function chunkMarkdown(
  markdown: string,
  opts: { maxChars?: number; overlap?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = opts.overlap ?? 120;
  if (maxChars <= 0) throw new Error("maxChars must be positive");

  const blocks = markdown
    .split(/\n(?=#{1,6}\s)/) // keep headings with the block that follows
    .flatMap((section) => section.split(/\n{2,}/))
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = "";
  };

  for (const block of blocks) {
    if (block.length > maxChars) {
      flush();
      let rest = block;
      while (rest.length > maxChars) {
        chunks.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars - overlap);
      }
      if (rest.trim().length > 0) current = rest;
      continue;
    }
    if (current.length > 0 && current.length + block.length + 2 > maxChars) {
      flush();
    }
    current = current.length > 0 ? `${current}\n\n${block}` : block;
  }
  flush();
  return chunks;
}
