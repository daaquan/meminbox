import { readConfigFiles, type ConfigFiles } from "./dotenv.js";

export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openaiApiKey: string | null;
  embeddingModel: string;
  extractModel: string;
  defaultProject: string;
  actor: string;
  /** Let MCP agents promote/archive and write active memory (default: humans only). */
  allowAgentPromote: boolean;
}

/**
 * Settings meminbox reads, by suffix. Each is looked up as `MEMINBOX_<name>`.
 *
 * Generic names such as SUPABASE_URL or OPENAI_API_KEY are deliberately NOT
 * read from the process environment or a project's ./.env: a developer's
 * shell and app repos are full of those, and picking them up would point
 * meminbox at an app's database or bill memory traffic to an unrelated
 * OpenAI key. The only place unprefixed names are still honoured is the
 * meminbox-owned ~/.meminbox/.env written by meminbox <= 0.3.
 */
const LEGACY_FILE_NAMES: Record<string, string> = {
  SUPABASE_URL: "SUPABASE_URL",
  SUPABASE_SERVICE_ROLE_KEY: "SUPABASE_SERVICE_ROLE_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY",
  EMBEDDING_MODEL: "EMBEDDING_MODEL",
  EXTRACT_MODEL: "EXTRACT_MODEL",
  DEFAULT_PROJECT: "MEMORY_DEFAULT_PROJECT",
  ACTOR: "MEMORY_ACTOR",
};

/**
 * Resolve one setting. Precedence:
 *   1. MEMINBOX_<name> in the real environment
 *   2. ~/.meminbox/.env (MEMINBOX_<name>, or the legacy unprefixed name)
 *   3. ./.env, MEMINBOX_<name> only (development convenience)
 */
export function resolveSetting(
  name: string,
  env: NodeJS.ProcessEnv,
  files: ConfigFiles,
): string | undefined {
  const key = `MEMINBOX_${name}`;
  const legacy = LEGACY_FILE_NAMES[name];
  const candidates = [
    env[key],
    // MEMORY_ACTOR is how 0.3 agent configs name the actor; keep honouring it.
    name === "ACTOR" ? env.MEMORY_ACTOR : undefined,
    files.home[key],
    legacy ? files.home[legacy] : undefined,
    files.local[key],
  ];
  return candidates.find((v) => v !== undefined && v !== "");
}

function required(name: string, env: NodeJS.ProcessEnv, files: ConfigFiles): string {
  const v = resolveSetting(name, env, files);
  if (!v) {
    throw new Error(
      `Missing required env var: MEMINBOX_${name}. Run \`meminbox init\` or see .env.example`,
    );
  }
  return v;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  files: ConfigFiles = readConfigFiles(),
): Config {
  const get = (name: string) => resolveSetting(name, env, files);
  return {
    supabaseUrl: required("SUPABASE_URL", env, files),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", env, files),
    openaiApiKey: get("OPENAI_API_KEY") ?? null,
    embeddingModel: get("EMBEDDING_MODEL") ?? "text-embedding-3-small",
    extractModel: get("EXTRACT_MODEL") ?? "gpt-4o-mini",
    defaultProject: get("DEFAULT_PROJECT") ?? "default",
    actor: get("ACTOR") ?? "cli",
    // Never from ./.env: a cloned repo must not be able to switch off the
    // human review gate for the agent working inside it.
    allowAgentPromote: /^(1|true|yes)$/i.test(
      resolveSetting("ALLOW_AGENT_PROMOTE", env, { home: files.home, local: {} }) ?? "",
    ),
  };
}
