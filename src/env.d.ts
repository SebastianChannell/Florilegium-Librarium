interface Env {
  /** Server-only Cloudflare Worker secret; never place in wrangler vars. */
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_URL: string;
}
