import { isPlanDateAllowed, resolveLocalDate } from "@/domain/days";

/**
 * A tiny stateful stand-in for the Supabase query builder, just faithful enough for the
 * `profiles` and `days` tables, plus a model of the `ensure_day()` RPC (below): rows persist between calls, and `upsert` honours the table's
 * unique key, `ignoreDuplicates` (DO NOTHING) and DO UPDATE the way Postgres does. It exists so
 * scenario tests can replay *sequences* of requests and assert on what ended up in the tables —
 * something a call-recording mock can't express. It does not model RLS.
 */
type Row = Record<string, unknown>;
interface UpsertOptions {
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

interface Chain {
  select(columns?: string): Chain;
  eq(column: string, value: unknown): Chain;
  upsert(row: Row, options?: UpsertOptions): Chain;
  update(values: Row): Chain;
  maybeSingle(): Promise<{ data: Row | null; error: null | { message: string } }>;
  single(): Promise<{ data: Row | null; error: null | { message: string } }>;
  then<T>(resolve: (value: { data: Row[]; error: null }) => T): Promise<T>;
}

const UNIQUE_KEY: Record<string, string[]> = {
  profiles: ["id"],
  days: ["user_id", "local_date"],
  plans: ["day_id"],
  plan_revisions: ["plan_id", "revision_number"],
};

export interface FakeDb {
  tables: { profiles: Row[]; days: Row[]; plans: Row[]; plan_revisions: Row[] };
  /** Every mutating call, in order — for asserting "nothing was written". */
  writes: { table: string; op: "upsert" | "update" | "rpc" }[];
  client: never;
}

export interface RpcError {
  code: string;
  message: string;
}

/**
 * A model of the SQL `ensure_day(p_local_date)` for the authenticated `userId` — the same
 * contract, not the same code (the real function is validated in a scratch PostgreSQL):
 * no profile → P0002; a date outside today … today+365 → 22023; null date = today in the
 * PROFILE timezone; an existing day is returned untouched (its timezone is FROZEN, never
 * re-read from the profile); otherwise the day is created with the profile timezone, together
 * with its plan and exactly one revision 1.
 */
export function createFakeDb(userId = "user-1"): FakeDb {
  const tables: FakeDb["tables"] = { profiles: [], days: [], plans: [], plan_revisions: [] };
  const writes: FakeDb["writes"] = [];
  let dayCounter = 0;

  const defaults = (table: string): Row =>
    table === "profiles" ? { timezone: "UTC" } : { id: `day-${++dayCounter}` };

  function from(table: "profiles" | "days" | "plans" | "plan_revisions"): Chain {
    let op: "select" | "upsert" | "update" = "select";
    let payload: Row = {};
    let options: UpsertOptions = {};
    const filters: [string, unknown][] = [];

    const matches = (row: Row) => filters.every(([column, value]) => row[column] === value);

    function execute(): { data: Row[]; error: null } {
      const rows = tables[table];
      if (op === "select") return { data: rows.filter(matches), error: null };

      if (op === "update") {
        writes.push({ table, op });
        const hit = rows.filter(matches);
        hit.forEach((row) => Object.assign(row, payload));
        return { data: hit, error: null };
      }

      writes.push({ table, op });
      const key = UNIQUE_KEY[table]!;
      const existing = rows.find((row) => key.every((column) => row[column] === payload[column]));
      if (existing) {
        if (options.ignoreDuplicates) return { data: [], error: null };
        Object.assign(existing, payload);
        return { data: [existing], error: null };
      }
      const created = { ...defaults(table), ...payload };
      rows.push(created);
      return { data: [created], error: null };
    }

    const chain: Chain = {
      select() {
        return chain;
      },
      eq(column, value) {
        filters.push([column, value]);
        return chain;
      },
      upsert(row, opts = {}) {
        op = "upsert";
        payload = row;
        options = opts;
        return chain;
      },
      update(values) {
        op = "update";
        payload = values;
        return chain;
      },
      async maybeSingle() {
        return { data: execute().data[0] ?? null, error: null };
      },
      async single() {
        const [row] = execute().data;
        return row ? { data: row, error: null } : { data: null, error: { message: "no row" } };
      },
      then(resolve) {
        return Promise.resolve(execute()).then(resolve);
      },
    };
    return chain;
  }

  function rpc(name: string, args: { p_local_date?: string | null }) {
    if (name !== "ensure_day")
      return Promise.resolve({ data: null, error: { code: "42883", message: name } });
    writes.push({ table: "days", op: "rpc" });
    const profile = tables.profiles.find((p) => p.id === userId);
    if (!profile)
      return Promise.resolve({ data: null, error: { code: "P0002", message: "no profile" } });
    const timezone = profile.timezone as string;
    const todayLocal = resolveLocalDate(new Date(), timezone);
    const date = args.p_local_date ?? todayLocal;
    if (!isPlanDateAllowed(date, todayLocal)) {
      return Promise.resolve({
        data: null,
        error: { code: "22023", message: "outside the horizon" },
      });
    }
    let day = tables.days.find((d) => d.user_id === userId && d.local_date === date);
    if (!day) {
      day = { id: `day-${++dayCounter}`, user_id: userId, local_date: date, timezone };
      tables.days.push(day);
    }
    let plan = tables.plans.find((p) => p.day_id === day!.id);
    if (!plan) {
      plan = { id: `plan-${tables.plans.length + 1}`, day_id: day.id, user_id: userId };
      tables.plans.push(plan);
    }
    if (!tables.plan_revisions.some((r) => r.plan_id === plan!.id)) {
      tables.plan_revisions.push({ plan_id: plan.id, revision_number: 1, source: "system" });
    }
    return Promise.resolve({ data: day, error: null });
  }

  return { tables, writes, client: { from, rpc } as never };
}
