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
Free tier is enough. Note the project URL and the **service role** key
(Project Settings → API).

### 2. Apply the schema

Supabase SQL Editor → paste `supabase/migrations/20261108000001_init.sql` → Run.
(Or `supabase db push` if you use the Supabase CLI.)

### 3. Configure and run

```bash
npm install
cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
npm run cli -- list    # smoke test: should print nothing (empty memory)
```

### 4. Connect your agents (MCP, stdio)

Set `MEMORY_ACTOR` differently per client so provenance says who wrote what.

Claude Code:

```bash
claude mcp add meminbox \
  -e SUPABASE_URL=https://your-project.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e MEMORY_ACTOR=claude-code \
  -- npx tsx /path/to/meminbox/src/mcp/server.ts
```

Codex / Cursor: same command and env, with `MEMORY_ACTOR=codex` / `cursor`,
in each client's MCP config.

### 5. First memory

```bash
npm run cli -- add --title "How we deploy" --text "Staging first, then prod. See runbook." --active
npm run cli -- search "deploy"
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

- v0 access is **service-role from your own machines only**. The service
  role key bypasses RLS; treat it like a root password. Never put it in a
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
