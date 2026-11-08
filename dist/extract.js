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
export async function extractCandidates(cfg, rawText, opts = {}) {
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
            model: opts.model ?? cfg.extractModel,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: "Extract durable knowledge worth remembering across future sessions: " +
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
    const json = (await res.json());
    return parseExtraction(json.choices[0]?.message.content ?? "{}");
}
/**
 * Validate the model's JSON BEFORE anything is written: a malformed item
 * used to fail the database insert halfway through, after earlier
 * candidates had already been filed. Items without a usable title and
 * content are dropped (and counted on stderr), never half-written.
 */
export function parseExtraction(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw new Error("Extraction failed: the model did not return valid JSON. Nothing was filed.");
    }
    const items = parsed?.items;
    if (!Array.isArray(items))
        return [];
    const out = [];
    for (const item of items) {
        const { title, content: body } = (item ?? {});
        if (typeof title === "string" && title.trim() && typeof body === "string" && body.trim()) {
            out.push({ title: title.trim(), contentMd: body.trim() });
        }
    }
    if (out.length < items.length) {
        console.error(`meminbox: skipped ${items.length - out.length} malformed extraction item(s)`);
    }
    return out;
}
//# sourceMappingURL=extract.js.map