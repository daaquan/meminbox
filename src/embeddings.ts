import type { Config } from "./config.js";

/**
 * Embeddings are OPTIONAL and DERIVED.
 * - No OPENAI_API_KEY -> returns null, callers fall back to keyword search.
 * - The embedding model/dims are configuration, not truth: changing them
 *   only means the chunk index must be rebuilt (`meminbox reindex`).
 */
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
    body: JSON.stringify({ model: cfg.embeddingModel, input: text }),
  });
  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  const vec = json.data[0]?.embedding;
  if (!vec) throw new Error("Embedding response had no vector");
  if (vec.length !== cfg.embeddingDims) {
    throw new Error(
      `Embedding dims mismatch: model returned ${vec.length}, schema expects ${cfg.embeddingDims}. ` +
        `Set EMBEDDING_DIMS to match the model, or keep the default model.`,
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
