import type { Config } from "./config.js";

/**
 * Embeddings are OPTIONAL and DERIVED.
 * - No MEMINBOX_OPENAI_API_KEY -> returns null, callers fall back to keyword search.
 * - The model is configuration, not truth: changing it only means the
 *   chunk index must be rebuilt (`meminbox reindex`).
 */

/** Width of meminbox_document_chunks.embedding — fixed by the schema. */
export const EMBEDDING_DIMS = 1536;
export async function embedText(
  cfg: Config,
  text: string,
): Promise<number[] | null> {
  if (!cfg.openaiApiKey) return null;
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.embeddingModel,
      input: text,
      // text-embedding-3-* can shorten to the schema's width (e.g. -large);
      // older models reject the parameter and are fixed at 1536 anyway.
      ...(cfg.embeddingModel.startsWith("text-embedding-3") ? { dimensions: EMBEDDING_DIMS } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  const vec = json.data[0]?.embedding;
  if (!vec) throw new Error("Embedding response had no vector");
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Embedding dims mismatch: ${cfg.embeddingModel} returned ${vec.length} dimensions, but meminbox stores ${EMBEDDING_DIMS}. ` +
        "Use an OpenAI text-embedding-3 model (or text-embedding-ada-002) as MEMINBOX_EMBEDDING_MODEL.",
    );
  }
  return vec;
}

export async function embedBatch(
  cfg: Config,
  texts: string[],
): Promise<Array<number[] | null>> {
  // v0: sequential calls keep failure handling simple. Batching is a
  // performance optimisation that belongs in the reindex path later.
  const out: Array<number[] | null> = [];
  for (const t of texts) out.push(await embedText(cfg, t));
  return out;
}
