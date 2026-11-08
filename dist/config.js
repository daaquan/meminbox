import { loadEnvFiles } from "./dotenv.js";
function required(name) {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Missing required env var: ${name}. Run \`meminbox init\` or see .env.example`);
    }
    return v;
}
export function loadConfig() {
    loadEnvFiles();
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
//# sourceMappingURL=config.js.map