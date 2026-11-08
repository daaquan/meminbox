import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";

export function createDb(cfg: Config): SupabaseClient {
  return createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
}
