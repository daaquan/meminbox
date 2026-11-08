/**
 * User-facing error presentation.
 *
 * Product rule: a person running the CLI should never see a stack trace.
 * Errors print as one clean message, plus a targeted hint when the
 * failure matches a known, fixable pattern. Set MEMINBOX_DEBUG=1 to get
 * the full stack when developing.
 */
export class SetupCancelled extends Error {
    constructor(message) {
        super(message);
        this.name = "SetupCancelled";
    }
}
const HINTS = [
    {
        match: /meminbox_\w+.*(does not exist|schema cache)|(does not exist|schema cache).*meminbox_\w+/i,
        hint: "Hint: the meminbox schema is missing or out of date in this project. Run `meminbox migrate` (meminbox 0.4 renamed its tables to meminbox_*; existing data is copied over).",
    },
    {
        match: /row-level security/i,
        hint: "Hint: this usually means the configured key is the anon / publishable key. meminbox needs the service role (secret) key — re-run `meminbox init` and paste the key labelled service_role / sb_secret_ from Project Settings → API.",
    },
    {
        match: /missing required env var/i,
        hint: "Hint: run `meminbox init` first to create your configuration.",
    },
    {
        match: /fetch failed|network|ENOTFOUND|ECONNREFUSED/i,
        hint: "Hint: the Supabase project could not be reached. Check the project URL in ~/.meminbox/.env and your network connection.",
    },
    {
        match: /invalid api key|invalid jwt|unauthorized/i,
        hint: "Hint: the stored key was rejected. Re-run `meminbox init` and paste the current service role (secret) key.",
    },
];
/** Format an unknown error for display: message + optional hint, no stack. */
export function friendlyError(err) {
    if (err instanceof SetupCancelled)
        return err.message;
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split("\n")[0].trim();
    const hint = HINTS.find((h) => h.match.test(message));
    return hint ? `${firstLine}\n${hint.hint}` : firstLine;
}
export function isDebug() {
    return process.env.MEMINBOX_DEBUG === "1";
}
//# sourceMappingURL=errors.js.map