-- meminbox 0.5: duplicate detection and idempotent imports.
--
-- content_hash  sha256 of the normalised Markdown body (CRLF -> LF, leading
--               and trailing whitespace trimmed). A write whose hash already
--               exists in the same project (and is not archived) returns the
--               existing document instead of storing a second copy.
-- source_key    stable identity of the thing a document was imported from
--               (e.g. "claude-code:<project dir>/<file>.md"). Unique per
--               project, so re-running `meminbox import` updates documents in
--               place instead of duplicating them.
--
-- Like every meminbox migration this is re-applied in full on each
-- `meminbox init` / `meminbox migrate`, so every statement is idempotent.

alter table public.meminbox_documents add column if not exists content_hash text;
alter table public.meminbox_documents add column if not exists source_key   text;

-- Backfill rows written before 0.5 (or by an older client since).
-- MUST match contentHash() in src/memory.ts. The pattern below is an E''
-- string so it contains literal tab / CR / LF characters.
update public.meminbox_documents
set content_hash = encode(
      sha256(convert_to(
        regexp_replace(replace(content_md, E'\r\n', E'\n'), E'^[ \t\r\n]+|[ \t\r\n]+$', '', 'g'),
        'UTF8')),
      'hex')
where content_hash is null;

create unique index if not exists meminbox_documents_source_key_uidx
  on public.meminbox_documents (project_id, source_key)
  where source_key is not null;

create index if not exists meminbox_documents_content_hash_idx
  on public.meminbox_documents (project_id, content_hash);
