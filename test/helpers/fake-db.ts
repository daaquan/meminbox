import type { SupabaseClient } from "@supabase/supabase-js";

export interface Call {
  table?: string;
  rpc?: string;
  op: string;
  args: unknown[];
}

type Responder = (call: { table?: string; rpc?: string; ops: Call[] }) => {
  data?: unknown;
  error?: { message: string } | null;
};

/**
 * Minimal stand-in for the supabase-js query builder: every chained call is
 * recorded, and awaiting the chain asks `respond` for the result.
 */
export function fakeDb(respond: Responder = () => ({ data: null })) {
  const calls: Call[] = [];
  const builder = (table: string) => {
    const ops: Call[] = [];
    const b: Record<string, unknown> = {};
    for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "order", "limit", "range", "single", "maybeSingle"]) {
      b[op] = (...args: unknown[]) => {
        const c = { table, op, args };
        ops.push(c);
        calls.push(c);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try {
        const r = respond({ table, ops });
        resolve({ data: r.data ?? null, error: r.error ?? null });
      } catch (e) {
        reject(e);
      }
    };
    return b;
  };
  const db = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: unknown) => {
      const c = { rpc: name, op: "rpc", args: [args] };
      calls.push(c);
      const r = respond({ rpc: name, ops: [c] });
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}
