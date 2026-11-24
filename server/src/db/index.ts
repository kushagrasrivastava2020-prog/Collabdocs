import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { SCHEMA_SQL } from './schema.js'

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface Db extends Queryable {
  readonly kind: 'postgres' | 'pglite'
  /** Run `fn` inside a transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

class PostgresDb implements Db {
  readonly kind = 'postgres' as const
  constructor(private pool: pg.Pool) {}

  async query<T>(sql: string, params?: unknown[]) {
    const r = await this.pool.query(sql, params as any[])
    return { rows: r.rows as T[] }
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn({
        query: async (sql, params) => ({ rows: (await client.query(sql, params as any[])).rows }),
      })
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async exec(sql: string) {
    await this.pool.query(sql)
  }

  async close() {
    await this.pool.end()
  }
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const
  constructor(
    private pg: PGlite,
    private releaseLock: () => void = () => {},
  ) {}

  async query<T>(sql: string, params?: unknown[]) {
    const r = await this.pg.query<T>(sql, params as any[])
    return { rows: r.rows }
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction((t) =>
      fn({
        query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await t.query<R>(sql, params as any[])).rows }),
      }),
    )
  }

  async exec(sql: string) {
    await this.pg.exec(sql)
  }

  async close() {
    await this.pg.close()
    this.releaseLock()
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * PGlite is single-process. A process killed without a clean shutdown (e.g. `tsx watch` reloads
 * on Windows, where there is no SIGTERM) leaves `postmaster.pid` behind and PGlite then refuses
 * to start. PGlite writes a fake PID into that file, so we keep our own lock with the real PID:
 * wait briefly for a live owner to exit, then clear stale locks.
 */
async function lockPgliteDir(dir: string): Promise<() => void> {
  const lockFile = path.join(dir, 'collabdocs.lock')
  for (let attempt = 0; ; attempt++) {
    const owner = fs.existsSync(lockFile) ? Number(fs.readFileSync(lockFile, 'utf8')) : NaN
    if (!owner || owner === process.pid || !isAlive(owner)) break
    if (attempt >= 50) throw new Error(`PGlite data dir ${dir} is in use by process ${owner}. Stop it or set PGLITE_DIR.`)
    await new Promise((r) => setTimeout(r, 100))
  }
  fs.rmSync(path.join(dir, 'postmaster.pid'), { force: true })
  // Sync clients (OneDrive) set the Windows read-only attribute on folders; Windows ignores it
  // for directories but PGlite's emulated filesystem doesn't. Clear it.
  if (process.platform === 'win32') fs.chmodSync(dir, 0o777)
  fs.writeFileSync(lockFile, String(process.pid))
  return () => {
    try {
      if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.rmSync(lockFile, { force: true })
    } catch {
      /* already gone */
    }
  }
}

export async function createDb(opts: { databaseUrl?: string; pgliteDir: string }): Promise<Db> {
  let db: Db
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 })
    db = new PostgresDb(pool)
  } else {
    const inMemory = opts.pgliteDir.startsWith('memory://')
    if (inMemory) {
      db = new PgliteDb(await PGlite.create())
    } else {
      fs.mkdirSync(opts.pgliteDir, { recursive: true })
      const release = await lockPgliteDir(opts.pgliteDir)
      db = new PgliteDb(await PGlite.create(opts.pgliteDir), release)
    }
  }
  await migrate(db)
  return db
}

async function migrate(db: Db) {
  if (db.kind === 'postgres') {
    // Several instances may boot at once; serialise migrations with an advisory lock.
    await db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(727274)')
      await q.query(SCHEMA_SQL)
    })
  } else {
    await db.exec(SCHEMA_SQL)
  }
}

/** pg returns BYTEA as Buffer, PGlite as Uint8Array; normalise to Uint8Array. */
export const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer))
/** BIGINT / COUNT columns come back as strings from pg. */
export const int = (v: unknown): number => Number(v)
