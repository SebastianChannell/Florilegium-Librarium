-- Harden the initial timestamp trigger function.
-- Preserve existing trigger behavior while fixing Supabase's mutable
-- function search_path security advisor warning.
alter function public.sf_touch_updated_at()
  set search_path = '';

-- Trigger-only function: no direct client execution is required.
revoke execute on function public.sf_touch_updated_at()
  from public, anon, authenticated;
