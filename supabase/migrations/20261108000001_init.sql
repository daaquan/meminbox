-- meminbox: initial schema
-- Design rule: `documents` is the source of truth (human-readable Markdown).
-- `document_chunks` (with embeddings) is a DERIVED index and can be dropped
-- and rebuilt at any time with `meminbox reindex`.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- projects: a namespace for a body of knowledge (one repo, one domain, ...)
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
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
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
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

create index if not exists documents_project_status_idx
  on public.documents (project_id, status);
create index if not exists documents_search_vector_idx
  on public.documents using gin (search_vector);
-- trigram index so substring search also works for Japanese text
create index if not exists documents_content_trgm_idx
  on public.documents using gin (content_md gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- document_chunks: derived index for semantic search (rebuildable)
-- ---------------------------------------------------------------------------
create table if not exists public.document_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index int  not null,
  content     text not null,
  embedding   vector(1536),
  created_at  timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists document_chunks_document_idx
  on public.document_chunks (document_id);
create index if not exists document_chunks_embedding_idx
  on public.document_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- audit_log: every write / promote / archive lands here
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor       text,
  action      text not null,
  document_id uuid references public.documents(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- search helpers
-- ---------------------------------------------------------------------------

-- Keyword search: FTS rank, with an ILIKE fallback so Japanese substring
-- queries (no word boundaries) still hit.
create or replace function public.search_documents(
  p_query  text,
  p_limit  int default 10,
  p_status text default 'active'
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
as $$
  select d.id, d.project_id, d.title, d.content_md, d.status,
         ts_rank(d.search_vector, websearch_to_tsquery('simple', p_query)) as rank,
         d.updated_at
  from public.documents d
  where d.status = p_status
    and (
      d.search_vector @@ websearch_to_tsquery('simple', p_query)
      or d.title ilike '%' || p_query || '%'
      or d.content_md ilike '%' || p_query || '%'
    )
  order by rank desc, d.updated_at desc
  limit p_limit;
$$;

-- Vector search over the derived chunks.
create or replace function public.match_chunks(
  p_embedding vector(1536),
  p_limit     int default 10,
  p_status    text default 'active'
)
returns table (
  document_id uuid,
  project_id  uuid,
  title       text,
  chunk       text,
  similarity  float
)
language sql stable
as $$
  select c.document_id, d.project_id, d.title, c.content,
         1 - (c.embedding <=> p_embedding) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where d.status = p_status
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
alter table public.projects        enable row level security;
alter table public.documents       enable row level security;
alter table public.document_chunks enable row level security;
alter table public.audit_log       enable row level security;

insert into public.projects (slug, name)
values ('default', 'Default')
on conflict (slug) do nothing;
