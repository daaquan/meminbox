-- meminbox: initial schema
-- Design rule: `meminbox_documents` is the source of truth (human-readable
-- Markdown). `meminbox_document_chunks` (with embeddings) is a DERIVED index
-- and can be dropped and rebuilt at any time with `meminbox reindex`.
--
-- Every object is prefixed `meminbox_` so the schema can never collide
-- with (or silently reuse) an application's own `projects` / `documents`
-- tables if it is applied to the wrong project.
--
-- Migrations are applied in full on every `meminbox init` / `meminbox
-- migrate`, so every statement here must stay idempotent.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- projects: a namespace for a body of knowledge (one repo, one domain, ...)
-- ---------------------------------------------------------------------------
create table if not exists public.meminbox_projects (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- documents: the source of truth
-- status:
--   inbox   = written by an agent, not yet reviewed/promoted (the default)
--   active  = trusted memory, returned by search by default
--   archived = retired; kept for history, excluded from search
-- provenance: who/what wrote this and from what, e.g.
--   {"agent": "claude-code", "session": "...", "source": "conversation", "uri": "..."}
-- ---------------------------------------------------------------------------
create table if not exists public.meminbox_documents (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.meminbox_projects(id) on delete cascade,
  title         text not null,
  content_md    text not null,
  status        text not null default 'inbox' check (status in ('inbox', 'active', 'archived')),
  source_agent  text,
  provenance    jsonb not null default '{}'::jsonb,
  version       int  not null default 1,
  search_vector tsvector generated always as (
                  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content_md, ''))
                ) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists meminbox_documents_project_status_idx
  on public.meminbox_documents (project_id, status);
create index if not exists meminbox_documents_search_vector_idx
  on public.meminbox_documents using gin (search_vector);
-- trigram index so substring search also works for Japanese text
create index if not exists meminbox_documents_content_trgm_idx
  on public.meminbox_documents using gin (content_md gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- document_chunks: derived index for semantic search (rebuildable)
-- ---------------------------------------------------------------------------
create table if not exists public.meminbox_document_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.meminbox_documents(id) on delete cascade,
  chunk_index int  not null,
  content     text not null,
  embedding   vector(1536),
  created_at  timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists meminbox_document_chunks_document_idx
  on public.meminbox_document_chunks (document_id);
create index if not exists meminbox_document_chunks_embedding_idx
  on public.meminbox_document_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- audit_log: every write / promote / archive lands here
-- ---------------------------------------------------------------------------
create table if not exists public.meminbox_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor       text,
  action      text not null,
  document_id uuid references public.meminbox_documents(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- search helpers
-- Both take an optional project filter (null = all projects) and pin
-- search_path so they cannot be redirected by a caller's session settings.
-- ---------------------------------------------------------------------------

-- Keyword search: FTS rank, with a substring fallback so Japanese queries
-- (no word boundaries) still hit. The query is escaped so `%` and `_` are
-- matched literally instead of acting as LIKE wildcards.
create or replace function public.meminbox_search_documents(
  p_query      text,
  p_limit      int  default 10,
  p_status     text default 'active',
  p_project_id uuid default null
)
returns table (
  id         uuid,
  project_id uuid,
  title      text,
  content_md text,
  status     text,
  rank       real,
  updated_at timestamptz
)
language sql stable
set search_path = public, extensions
as $$
  with q as (
    select websearch_to_tsquery('simple', p_query) as tsq,
           '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select d.id, d.project_id, d.title, d.content_md, d.status,
         ts_rank(d.search_vector, q.tsq) as rank,
         d.updated_at
  from public.meminbox_documents d, q
  where d.status = p_status
    and (p_project_id is null or d.project_id = p_project_id)
    and (
      d.search_vector @@ q.tsq
      or d.title ilike q.pattern
      or d.content_md ilike q.pattern
    )
  order by rank desc, d.updated_at desc
  limit p_limit;
$$;

-- Vector search over the derived chunks.
-- HNSW returns at most hnsw.ef_search candidates (default 40) BEFORE the
-- status/project filter is applied, which silently starved results; raise
-- it for this function so p_limit (up to 150) can actually be met.
create or replace function public.meminbox_match_chunks(
  p_embedding  vector(1536),
  p_limit      int  default 10,
  p_status     text default 'active',
  p_project_id uuid default null
)
returns table (
  document_id uuid,
  project_id  uuid,
  title       text,
  chunk       text,
  similarity  float
)
language sql stable
set search_path = public, extensions
set hnsw.ef_search = 400
as $$
  select c.document_id, d.project_id, d.title, c.content,
         1 - (c.embedding <=> p_embedding) as similarity
  from public.meminbox_document_chunks c
  join public.meminbox_documents d on d.id = c.document_id
  where d.status = p_status
    and (p_project_id is null or d.project_id = p_project_id)
    and c.embedding is not null
  order by c.embedding <=> p_embedding
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled with NO public policies on purpose.
-- All access in v0 goes through the service role key from the owner's own
-- machines (MCP server / CLI). If a hosted/remote endpoint is added later,
-- write explicit policies then — do not open these tables to anon.
-- ---------------------------------------------------------------------------
alter table public.meminbox_projects        enable row level security;
alter table public.meminbox_documents       enable row level security;
alter table public.meminbox_document_chunks enable row level security;
alter table public.meminbox_audit_log       enable row level security;

insert into public.meminbox_projects (slug, name)
values ('default', 'Default')
on conflict (slug) do nothing;
