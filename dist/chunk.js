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
export function chunkMarkdown(markdown, opts = {}) {
    const maxChars = opts.maxChars ?? 1200;
    // the default overlap shrinks with small maxChars so it always fits
    const overlap = opts.overlap ?? Math.min(120, Math.floor(maxChars / 4));
    if (maxChars <= 0)
        throw new Error("maxChars must be positive");
    // overlap >= maxChars would never advance through an oversized block
    if (overlap < 0 || overlap >= maxChars) {
        throw new Error("overlap must be at least 0 and smaller than maxChars");
    }
    const blocks = markdown
        .split(/\n(?=#{1,6}\s)/) // keep headings with the block that follows
        .flatMap((section) => section.split(/\n{2,}/))
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
    const chunks = [];
    let current = "";
    const flush = () => {
        if (current.trim().length > 0)
            chunks.push(current.trim());
        current = "";
    };
    for (const block of blocks) {
        if (block.length > maxChars) {
            flush();
            let rest = block;
            while (rest.length > maxChars) {
                const cut = safeCut(rest, maxChars);
                chunks.push(rest.slice(0, cut));
                rest = rest.slice(safeCut(rest, Math.max(1, cut - overlap)));
            }
            if (rest.trim().length > 0)
                current = rest;
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
/**
 * Move a cut index back by one if it would split a UTF-16 surrogate pair
 * (emoji, rare CJK), which would leave a lone surrogate the embedding API
 * and Postgres reject.
 */
function safeCut(text, index) {
    if (index <= 0 || index >= text.length)
        return index;
    const before = text.charCodeAt(index - 1);
    const at = text.charCodeAt(index);
    const splitsPair = before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
    return splitsPair && index > 1 ? index - 1 : index;
}
//# sourceMappingURL=chunk.js.map