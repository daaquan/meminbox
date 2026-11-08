export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openaiApiKey: string | null;
  embeddingModel: string;
  embeddingDims: number;
  defaultProject: string;
  actor: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

export function loadConfig(): Config {
  return {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    openaiApiKey: process.env.OPENAI_API_KEY || null,
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    embeddingDims: Number(process.env.EMBEDDING_DIMS || 1536),
    defaultProject: process.env.MEMORY_DEFAULT_PROJECT || "default",
    actor: process.env.MEMORY_ACTOR || "cli",
  };
}
