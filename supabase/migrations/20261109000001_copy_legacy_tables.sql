-- meminbox: carry data over from the pre-0.4 unprefixed tables.
--
-- meminbox <= 0.3 created public.projects / documents / document_chunks /
-- audit_log. 0.4 uses meminbox_* names instead. This copies an existing
-- install's data across ONCE: only when the new documents table is still
-- empty, and only when the old tables carry meminbox's exact shape, so an
-- application's own `projects` / `documents` tables are never read.
--
-- The old tables and functions are left in place. Once you have checked
-- the copy, drop them yourself:
--   drop function if exists public.search_documents(text, int, text);
--   drop function if exists public.match_chunks(vector, int, text);
--   drop table if exists public.audit_log, public.document_chunks,
--                        public.documents, public.projects;
-- (only if those tables are meminbox's and not your application's).

do $$
declare
  legacy_shape boolean;
begin
  select
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'projects'
        and column_name in ('id', 'slug', 'name', 'created_at')) = 4
    and (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'documents'
        and column_name in ('id', 'project_id', 'title', 'content_md', 'status',
                            'source_agent', 'provenance', 'version',
                            'search_vector', 'created_at', 'updated_at')) = 11
    and (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'document_chunks'
        and column_name in ('id', 'document_id', 'chunk_index', 'content',
                            'embedding', 'created_at')) = 6
    and (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_log'
        and column_name in ('id', 'actor', 'action', 'document_id',
                            'metadata', 'created_at')) = 6
  into legacy_shape;

  if not legacy_shape then
    return;
  end if;
  if exists (select 1 from public.meminbox_documents) then
    return; -- already copied (or already in use): never copy twice
  end if;

  -- Projects: match by slug, so the 'default' row created by the init
  -- migration absorbs the legacy 'default' project.
  insert into public.meminbox_projects (id, slug, name, created_at)
  select p.id, p.slug, p.name, p.created_at
  from public.projects p
  on conflict (slug) do nothing;

  insert into public.meminbox_documents
    (id, project_id, title, content_md, status, source_agent, provenance,
     version, created_at, updated_at)
  select d.id, mp.id, d.title, d.content_md, d.status, d.source_agent,
         d.provenance, d.version, d.created_at, d.updated_at
  from public.documents d
  join public.projects p on p.id = d.project_id
  join public.meminbox_projects mp on mp.slug = p.slug;

  insert into public.meminbox_document_chunks
    (id, document_id, chunk_index, content, embedding, created_at)
  select c.id, c.document_id, c.chunk_index, c.content, c.embedding, c.created_at
  from public.document_chunks c
  where c.document_id in (select id from public.meminbox_documents);

  insert into public.meminbox_audit_log
    (id, actor, action, document_id, metadata, created_at)
  select a.id, a.actor, a.action,
         case when a.document_id in (select id from public.meminbox_documents)
              then a.document_id end,
         a.metadata, a.created_at
  from public.audit_log a;

  raise notice 'meminbox: copied legacy tables into meminbox_* (old tables left in place)';
end;
$$;
