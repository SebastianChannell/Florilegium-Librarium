-- Preserve Airtable Books > Notes as an editable Supabase column.
-- The source CSV also remains archived in each book's airtable_fields JSONB.
alter table public.books add column if not exists notes text;
