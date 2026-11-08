export type DocumentStatus = "inbox" | "active" | "archived";

export interface Provenance {
  /** Agent / tool that produced this memory, e.g. "claude-code", "codex", "muse". */
  agent?: string;
  /** Session or conversation identifier, when available. */
  session?: string;
  /** Where the content came from: "conversation" | "manual" | "extraction" | ... */
  source?: string;
  /** Link back to the original material, when there is one. */
  uri?: string;
  [key: string]: unknown;
}

export interface MemoryDocument {
  id: string;
  project_id: string;
  title: string;
  content_md: string;
  status: DocumentStatus;
  source_agent: string | null;
  provenance: Provenance;
  version: number;
  /** sha256 of the normalised content; null only on rows not yet backfilled. */
  content_hash: string | null;
  /** Identity of the imported source this document mirrors, if any. */
  source_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchHit {
  documentId: string;
  title: string;
  snippet: string;
  /** Combined score in [0, 1]; higher is better. */
  score: number;
  /** Which retrieval path produced this hit. */
  via: Array<"keyword" | "vector">;
}
