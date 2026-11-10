interface Env {
  /** Server-only Cloudflare Worker secret; never place in wrangler vars. */
  SUPABASE_SECRET_KEY?: string;
  /** Optional replacement for the previous hard-coded manual refresh key. */
  MANUAL_REFRESH_KEY?: string;
  SUPABASE_URL: string;
}
