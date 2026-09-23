/**
 * A tiny stateful stand-in for the Supabase query builder, just faithful enough for the
 * `profiles` and `days` tables: rows persist between calls, and `upsert` honours the table's
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

const UNIQUE_KEY: Record<string, string[]> = { profiles: ["id"], days: ["user_id", "local_date"] };

export interface FakeDb {
  tables: { profiles: Row[]; days: Row[] };
  /** Every mutating call, in order — for asserting "nothing was written". */
  writes: { table: string; op: "upsert" | "update" }[];
  client: never;
}

export function createFakeDb(): FakeDb {
  const tables: FakeDb["tables"] = { profiles: [], days: [] };
  const writes: FakeDb["writes"] = [];
  let dayCounter = 0;

  const defaults = (table: string): Row =>
    table === "profiles" ? { timezone: "UTC" } : { id: `day-${++dayCounter}` };

  function from(table: "profiles" | "days"): Chain {
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

  return { tables, writes, client: { from } as never };
}
