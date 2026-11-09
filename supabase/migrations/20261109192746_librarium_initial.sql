-- Sacrum Florilegium / Librarium — initial Supabase schema.
-- Run on a NEW Supabase project. This migration creates tables; it does not
-- alter Airtable or the currently deployed Cloudflare Workers.
-- The public schema is used for the Supabase Data API, but RLS is enabled
-- without public-access policies. Server-side secret keys only.

create table public.authors (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  name text not null,
  sort_name text,
  honorific text,
  religious_order text,
  source_created_at timestamptz,
  airtable_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index authors_name_idx on public.authors (lower(name));

create table public.classifications (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  class text not null,
  description text,
  source_created_at timestamptz,
  airtable_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index classifications_class_name_idx on public.classifications (lower(class));

create table public.books (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  title text,
  slug text unique,
  status text not null default 'Draft',
  subjects text[] not null default '{}'::text[],
  language text,
  original_language text,
  edition_year text,
  publisher text,
  source text,
  date_added date,
  pages integer check (pages is null or pages >= 0),
  r2_key text unique,
  content_hash text,
  file_size bigint check (file_size is null or file_size >= 0),
  file_type text,
  pdf_available boolean,
  local_pdf text,
  cover_url text,
  cover_page integer check (cover_page is null or cover_page >= 1),
  searchable_text boolean,
  ocr boolean,
  ingest_status text,
  ingest_message text,
  last_ingested timestamptz,
  source_created_at timestamptz,
  airtable_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index books_status_idx on public.books (status);
create index books_added_idx on public.books (date_added desc nulls last);
create index books_subjects_idx on public.books using gin (subjects);

-- Airtable can link a book to several authors or classifications.
-- Preserve those relations rather than flattening them into display strings.
create table public.book_authors (
  book_id uuid not null references public.books(id) on delete cascade,
  author_id uuid not null references public.authors(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (book_id, author_id)
);

create index book_authors_author_idx on public.book_authors (author_id);

create table public.book_classifications (
  book_id uuid not null references public.books(id) on delete cascade,
  classification_id uuid not null references public.classifications(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (book_id, classification_id)
);

create index book_classifications_class_idx on public.book_classifications (classification_id);

-- Preserve the existing 'Unpublished' Airtable table without presuming its
-- fields are identical to Books. Refine this after inspecting its CSV export.
create table public.unpublished (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  title text,
  source_created_at timestamptz,
  airtable_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Read-only projection to simplify a future Supabase -> R2 snapshot builder.
-- security_invoker ensures view access follows the caller's own permissions.
create view public.published_books
with (security_invoker = true)
as
select
  b.id,
  b.airtable_id,
  b.title,
  b.slug,
  b.subjects,
  b.language,
  b.pages,
  b.date_added,
  b.cover_url,
  b.cover_page,
  b.r2_key,
  coalesce((
    select array_agg(a.name order by ba.sort_order, a.name)
    from public.book_authors ba
    join public.authors a on a.id = ba.author_id
    where ba.book_id = b.id
  ), '{}'::text[]) as authors,
  (
    select c.class
    from public.book_classifications bc
    join public.classifications c on c.id = bc.classification_id
    where bc.book_id = b.id
    order by bc.sort_order, c.class
    limit 1
  ) as classification
from public.books b
where b.status = 'Published'
  and nullif(btrim(b.slug), '') is not null
  and nullif(btrim(b.title), '') is not null;

create function public.sf_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger authors_update_timestamp
before update on public.authors
for each row execute function public.sf_touch_updated_at();

create trigger classifications_update_timestamp
before update on public.classifications
for each row execute function public.sf_touch_updated_at();

create trigger books_update_timestamp
before update on public.books
for each row execute function public.sf_touch_updated_at();

create trigger unpublished_update_timestamp
before update on public.unpublished
for each row execute function public.sf_touch_updated_at();

-- Restrict every catalog table, including join tables and the view.
alter table public.authors enable row level security;
alter table public.classifications enable row level security;
alter table public.books enable row level security;
alter table public.book_authors enable row level security;
alter table public.book_classifications enable row level security;
alter table public.unpublished enable row level security;

revoke all on table
  public.authors,
  public.classifications,
  public.books,
  public.book_authors,
  public.book_classifications,
  public.unpublished,
  public.published_books
from anon, authenticated;

-- Supabase's server-side secret key runs as service_role. Do not place it in
-- browser code, public GitHub variables, or a publicly accessible R2 object.
grant select, insert, update, delete on
  public.authors,
  public.classifications,
  public.books,
  public.book_authors,
  public.book_classifications,
  public.unpublished
to service_role;

grant select on public.published_books to service_role;
