// Repository — the only module that writes SQL for the object model.
// Takes a D1-compatible database handle; no HTTP, no auth, no business rules.

export type Db = {
  prepare(sql: string): {
    bind(...args: any[]): { run(): Promise<any>; first(): Promise<any>; all(): Promise<any> };
    run(): Promise<any>; first(): Promise<any>; all(): Promise<any>;
  };
  batch?(statements: any[]): Promise<any[]>;
};

const q = (db: Db, sql: string, ...args: any[]) => db.prepare(sql).bind(...args);

export async function first(db: Db, sql: string, ...args: any[]) {
  return (await q(db, sql, ...args).first()) || null;
}

export async function all(db: Db, sql: string, ...args: any[]) {
  return (await q(db, sql, ...args).all())?.results || [];
}

export async function run(db: Db, sql: string, ...args: any[]) {
  return q(db, sql, ...args).run();
}

export async function batch(db: Db, statements: any[]) {
  if (db.batch) return db.batch(statements);
  const out = [];
  for (const s of statements) out.push(await s.run());
  return out;
}

export const stmt = (db: Db, sql: string, ...args: any[]) => q(db, sql, ...args);

export function newId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
