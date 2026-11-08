import { createClient } from "@supabase/supabase-js";
export function createDb(cfg) {
    return createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
        auth: { persistSession: false },
    });
}
//# sourceMappingURL=db.js.map