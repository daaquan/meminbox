import type { Config } from "../../src/config.js";

export const cfg: Config = {
  supabaseUrl: "https://x.supabase.co",
  supabaseServiceRoleKey: "sb_secret_x",
  openaiApiKey: null,
  embeddingModel: "text-embedding-3-small",
  extractModel: "gpt-4o-mini",
  defaultProject: "default",
  actor: "test",
};
