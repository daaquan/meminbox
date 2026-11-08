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
   Memory is human-readable Markdown in a Postgres table (`meminbox_documents`).
   You can read it, edit it, export it with `pg_dump`, and leave with it.
   No proprietary payload, no lock-in.
2. **Vectors are a derived index, never the truth.**
   `meminbox_document_chunks` + pgvector exist only to make search better. Drop them
   and run `meminbox reindex` and they come back. Changing the embedding
   model is a reindex, not a migration.
3. **Agent writes land in an inbox first.**
   Shared memory amplifies errors: one agent's wrong note becomes every
   agent's fact. So writes default to `status = 'inbox'` and only become
   trusted memory on `promote`. Every document carries **provenance**
   (which agent, which session, what source) and every action is in
   `meminbox_audit_log`.
4. **Extraction is a replaceable component, not the foundation.**
   `src/extract.ts` turns raw transcripts into inbox candidates. It is a
   small interface — swap in mem0, a local model, anything — because
   extracted facts are inputs to review, not the store itself.
5. **Keyword search is a first-class mode.**
   At personal scale (hundreds–thousands of documents), full-text +
   substring search carries most of the weight. Embeddings are optional:
   no `MEMINBOX_OPENAI_API_KEY`, no vector search, everything else still works.

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
                                        │  meminbox_documents      │
                                        │  meminbox_document_chunks│
                                        │  meminbox_audit_log      │
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
npm install -g meminbox
# from source instead: npm install -g github:daaquan/meminbox
```

### 3. Initialise

```bash
meminbox init
```

This prompts for your Supabase credentials, applies the schema when a
connection string is provided (otherwise it tells you which SQL file to
paste into the Supabase SQL Editor), saves your configuration to
`~/.meminbox/.env` (mode `0600`), and smoke-tests the connection.

**Fastest path — Supabase CLI:** if the official
[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
is installed and you have run `supabase login`, `meminbox init` detects
it and does everything through the CLI: it lists your projects, fetches
the chosen project's service key, and applies the schema — no dashboard
copy-paste. Your CLI access token never leaves the CLI; meminbox only
consumes its command output and stores the project's own key. It always
asks before using a project — even the one `supabase link` points at, or
your account's only project — because that is often an app's production
project. Non-interactive runs (`--yes`) need `--project-ref <ref>` unless
the account has exactly one project (`--no-cli` forces the manual flow).

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

For Claude Code this registers the server with `claude mcp add-json
--scope user` (Claude Code rewrites `~/.claude.json` while running, so the
file is not edited directly). For the other clients it writes the MCP
server entry into the client's own config file (backing up the previous
one to `<file>.bak`). The entry contains **no
secrets** — the server reads `~/.meminbox/.env` itself. Each client gets
its own `MEMINBOX_ACTOR`, so provenance shows which agent wrote what.
Use `--print` to preview the entry without writing anything.
Restart the client afterwards.

### 5. First memory

```bash
meminbox add --title "How we deploy" --text "Staging first, then prod. See runbook." --active
meminbox search "deploy"
```

### 6. Import what your agents already remember

```bash
meminbox import --dry-run          # show what would be imported, write nothing
meminbox import                    # Claude Code + Codex + Gemini CLI, whatever exists here
meminbox import --from claude-code # just one source (comma-separate several)
meminbox import --dir .cursor/rules --agent cursor   # any folder of Markdown
```

| Source | Reads |
|---|---|
| `claude-code` | `~/.claude/projects/<project>/memory/*.md` (`MEMORY.md`, the index, is skipped; `$CLAUDE_CONFIG_DIR` respected). Each project lands in a meminbox project named after the repository. |
| `codex` | `~/.codex/memories/**/*.md` (`$CODEX_HOME` respected) |
| `gemini` | the `## Gemini Added Memories` section of `~/.gemini/GEMINI.md` |
| `--dir <path>` | every `.md` / `.mdc` / `.markdown` file under the folder (hidden folders and `node_modules` skipped) |

Imports are **safe to re-run**: every document remembers the file it
came from, so a second run only updates files that changed (a changed
file goes back to the inbox for review) and leaves the rest alone.
Documents you archived stay archived. Imported documents land in the
inbox unless you pass `--active`; `--project <slug>` puts everything in
one project. Files that look like they contain credentials (API keys,
tokens, private keys) are **skipped** — only the kind of secret is
reported, never the value — unless you pass `--allow-secrets`.
The source files are only read, never modified.

### Duplicates

Every write is checked against the project's existing memory: identical
content (ignoring line endings and surrounding whitespace) that is already
in the inbox or active returns the existing document instead of storing
a second copy. `meminbox add` prints `Already stored`, and the MCP
`memory_write` result says `outcome: "duplicate"`, so agents can tell.

### Configuration

All settings are `MEMINBOX_*` (see `.env.example`). meminbox never reads
generic names like `SUPABASE_URL` or `OPENAI_API_KEY` from your shell or
from a project's `.env`, so it cannot be pointed at an app's database or
an unrelated API key by accident. Precedence: `MEMINBOX_*` environment
variables, then `~/.meminbox/.env`, then `MEMINBOX_*` lines in `./.env`.
A `~/.meminbox/.env` written by meminbox 0.3 (unprefixed names) still works.

### Upgrading

After installing a new version, apply any schema changes to your
configured project:

```bash
meminbox migrate          # via the Supabase CLI, or: --database-url <postgres-url>
```

**0.5 adds duplicate detection** (`content_hash` / `source_key` columns,
backfilled for existing documents) — run `meminbox migrate` before
using 0.5 against an existing project.

**0.4 renamed every table and function to `meminbox_*`** so the schema
can never collide with an application's own `projects` / `documents`
tables. `meminbox migrate` copies your existing data across once; the old
tables are left in place for you to drop after checking (the statements
are in `supabase/migrations/20261109000001_copy_legacy_tables.sql`).

### Development (from a clone)

```bash
npm install        # then: npm run build to refresh dist/ (dist/ is committed
                   # so git-based installs work without building)
npm test
npm run cli -- list
```

## MCP tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid search over **active** memory (`includeInbox` to also search the inbox, `project` to limit to one project) |
| `memory_read` | Read a document in full |
| `memory_write` | Write a document — **always to the inbox** (see below) |
| `memory_extract` | Extract durable candidates from raw text into the inbox |
| `memory_promote` | Promote inbox → active, or archive — only offered with `MEMINBOX_ALLOW_AGENT_PROMOTE=1` |
| `memory_list` | List documents by status |
| `memory_projects` | List projects (namespaces) |

Promotion is a **human** action by default: agents can write to the inbox
but cannot promote, archive or write active memory, so one agent's
mistake cannot turn itself into every agent's fact. Review with
`meminbox list --status inbox` and `meminbox promote <id>`. To let agents
promote too, set `MEMINBOX_ALLOW_AGENT_PROMOTE=1` in the environment or
`~/.meminbox/.env` (a project's `./.env` cannot turn it on).

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

- `embedBatch` is sequential; reindex of large libraries will want batching.
- No web UI yet: the human window is the CLI + Supabase Table Editor.
  A small read/review UI for the inbox is the natural next step.
- No remote (HTTP) MCP transport yet — stdio only, one process per client,
  all sharing the same database.
- Import is one-way (files → meminbox). Nothing is written back to an
  agent's own memory files, and near-duplicates (similar but not identical
  text) are not detected yet.

## License

MIT — see [LICENSE](./LICENSE).
