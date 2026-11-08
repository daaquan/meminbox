import type { Config } from "./config.js";

export interface ExtractedCandidate {
  title: string;
  contentMd: string;
}

/**
 * The "mem0 as a component" piece — and ONLY that piece.
 *
 * Extraction turns raw material (a conversation, a session log) into
 * candidate memories. Candidates are written to the INBOX, never directly
 * to active memory: extraction is fallible, and shared memory amplifies
 * errors. A human (or an explicit promote call) is the quality gate.
 *
 * This implementation is deliberately small and swappable. If a dedicated
 * extractor (mem0, a local model, ...) proves better on your own data,
 * replace `extractCandidates` behind this interface — nothing else changes,
 * because extracted facts are not the source of truth; documents are.
 */
export async function extractCandidates(
  cfg: Config,
  rawText: string,
  opts: { model?: string } = {},
): Promise<ExtractedCandidate[]> {
  if (!cfg.openaiApiKey) {
    // No LLM configured: keep the raw material as a single inbox candidate
    // rather than pretending extraction happened.
    return [{ title: "Unprocessed note", contentMd: rawText }];
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? process.env.EXTRACT_MODEL ?? "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract durable knowledge worth remembering across future sessions: " +
            "decisions and their reasons, procedures, stable facts about the user or a project. " +
            "Skip small talk, transient status, and anything already generic. " +
            'Return JSON: {"items": [{"title": string, "content": string}]} where content is ' +
            "self-contained Markdown that makes sense without the original conversation. " +
            "Preserve concrete details (names, paths, versions, dates). If nothing is durable, return an empty list.",
        },
        { role: "user", content: rawText },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Extraction request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const parsed = JSON.parse(json.choices[0]?.message.content ?? "{}") as {
    items?: Array<{ title: string; content: string }>;
  };
  return (parsed.items ?? []).map((i) => ({
    title: i.title,
    contentMd: i.content,
  }));
}
