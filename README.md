# meminbox

**Every agent writes to the inbox. Only reviewed memory becomes shared truth.**

Shared memory for AI agents, stored in **your own Supabase project**.

One memory that Claude Code, Codex, Cursor and any other MCP client read and
write through the same interface — instead of every agent keeping its own
private notes that die with its session.

## Design (the parts that matter)

This project borrows Cerefox's philosophy and uses extraction (the mem0
idea) as a component — in that order, on purpose:

1. **Documents are the source of truth.**
   Memory is human-readable Markdown in a Postgres table (`documents`).
   You can read it, edit it, export it with `pg_dump`, and leave with it.
   No proprietary payload, no lock-in.
2. **Vectors are a derived index, never the truth.**
   `document_chunks` + pgvector exist only to make search better. Drop them
   and run `meminbox reindex` and they come back. Changing the embedding
   model is a reindex, not a migration.
3. **Agent writes land in an inbox first.**
   Shared memory amplifies errors: one agent's wrong note becomes every
   agent's fact. So writes default to `status = 'inbox'` and only become
   trusted memory on `promote`. Every document carries **provenance**
   (which agent, which session, what source) and every action is in
   `audit_log`.
4. **Extraction is a replaceable component, not the foundation.**
   `src/extract.ts` turns raw transcripts into inbox candidates. It is a
   small interface — swap in mem0, a local model, anything — because
   extracted facts are inputs to review, not the store itself.
5. **Keyword search is a first-class mode.**
   At personal scale (hundreds–thousands of documents), full-text +
   substring search carries most of the weight. Embeddings are optional:
   no `OPENAI_API_KEY`, no vector search, everything else still works.

## Architecture

```
 Claude Code ─┐
 Codex ───────┤  MCP (stdio)        ┌──────────────────────────────┐
 Cursor ──────┼───────────────────► │ meminbox MCP server      │
 Muse (files)┤  CLI / import        │  search · write · extract    │
 Human ───────┘  CLI + Supabase UI  └──────────────┬───────────────┘
                                                   │ service role (local only)
                                        ┌──────────▼───────────────┐
                                        │ Your Supabase project    │
                                        │  documents  (truth)      │
                                        │  document_chunks (index) │
                                        │  audit_log               │
                                        └──────────────────────────┘
```

## Setup

### 1. Create a Supabase project

Use a **dedicated** project for memory (don't mix it into an app's project).
Free tier is enough. You'll need:

- the project URL and **service role** key (Project Settings → API)
- optionally, the Postgres **connection string** (Project Settings →
  Database) — if you provide it, `init` applies the schema for you;
  it is used once and never saved

### 2. Install

```bash
npm install -g github:daaquan/meminbox
# (once published to npm, this becomes: npm install -g meminbox)
```

### 3. Initialise

```bash
meminbox init
```

This prompts for your Supabase credentials, applies the schema when a
connection string is provided (otherwise it tells you which SQL file to
paste into the Supabase SQL Editor), saves your configuration to
`~/.meminbox/.env` (mode `0600`), and smoke-tests the connection.

Non-interactive form:

```bash
meminbox init --yes \
  --url https://your-project.supabase.co \
  --service-key <service-role-key> \
  --database-url <postgres-connection-string>
```

### 4. Connect your agents

```bash
meminbox configure-agent --tool claude-code   # or: codex | cursor | claude-desktop
```

This writes the MCP server entry into the client's own config file
(backing up the previous one to `<file>.bak`). The entry contains **no
secrets** — the server reads `~/.meminbox/.env` itself. Each client gets
its own `MEMORY_ACTOR`, so provenance shows which agent wrote what.
Use `--print` to preview the entry without writing anything.
Restart the client afterwards.

### 5. First memory

```bash
meminbox add --title "How we deploy" --text "Staging first, then prod. See runbook." --active
meminbox search "deploy"
```

### Development (from a clone)

```bash
npm install        # also builds dist/ via the prepare script
npm test
npm run cli -- list
```

## MCP tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid search over **active** memory (`includeInbox` to also search the inbox) |
| `memory_read` | Read a document in full |
| `memory_write` | Write a document — **inbox by default** |
| `memory_extract` | Extract durable candidates from raw text into the inbox |
| `memory_promote` | Promote inbox → active, or archive |
| `memory_list` | List documents by status |
| `memory_projects` | List projects (namespaces) |

## Security notes (read before connecting anything)

- Access is **service-role from your own machines only**. The service
  role key bypasses RLS; treat it like a root password. `meminbox init`
  keeps it in exactly one place — `~/.meminbox/.env`, mode `0600` — and
  agent client configs never contain it. Never put it in a
  browser, a hosted endpoint, or a repo.
- RLS is enabled with no public policies on purpose. A future remote MCP
  endpoint must add per-agent tokens and explicit policies first.
- Anything an agent can read, a prompt injection in its input can try to
  exfiltrate. The inbox/promote gate limits *writes*; reads of active memory
  are trusted-agent-only by design.

## Known limitations / roadmap

- Search RPCs don't filter by project yet (single-project use is the v0
  assumption); project filtering is the next migration.
- `embedBatch` is sequential; reindex of large libraries will want batching.
- No web UI yet: the human window is the CLI + Supabase Table Editor.
  A small read/review UI for the inbox is the natural next step.
- No remote (HTTP) MCP transport yet — stdio only, one process per client,
  all sharing the same database.
- Muse's own file-based memory does not plug into this directly; bridging
  it means an import/export sync, which is intentionally not faked here.

## License

MIT — see [LICENSE](./LICENSE).
