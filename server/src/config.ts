import os from 'node:os'
import path from 'node:path'

export interface Config {
  port: number
  host: string
  /** Postgres connection string. When unset an embedded PGlite database is used instead. */
  databaseUrl?: string
  /** Directory for the embedded PGlite database. `memory://` keeps everything in RAM. */
  pgliteDir: string
  /** Redis connection string. When unset, rooms are only shared inside this process. */
  redisUrl?: string
  jwtSecret: string
  cookieSecure: boolean
  /** Origins allowed to open WebSockets (CSWSH protection). Empty = same-origin / any. */
  allowedOrigins: string[]
  /** Built client to serve as static files (production single-container mode). */
  clientDist?: string
  instanceId: string
  /** How long incoming updates are buffered before being appended to the op log. */
  flushIntervalMs: number
  /** Take an automatic snapshot after this many op-log appends... */
  snapshotEveryFlushes: number
  /** ...or after this much time with unsnapshotted appends. */
  snapshotIntervalMs: number
  /** Unload a room this long after its last client disconnects. */
  roomIdleMs: number
  /** Max auth requests per IP per 15 minutes. 0 disables the limiter. */
  authRateLimit: number
  /** Sustained WebSocket messages/s allowed per connection (bursts of 2x). 0 disables. */
  wsRateLimit: number
  /** Export Node process metrics (CPU, memory, GC, event loop) on /metrics. */
  processMetrics: boolean
  logLevel: 'silent' | 'info' | 'debug'
}

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v))

/**
 * Default location for the embedded database: a per-user, non-synced data directory rather than
 * the project folder. Live database files inside OneDrive/Dropbox/iCloud folders get locked or
 * marked read-only by the sync client, which breaks PGlite (and risks corruption).
 */
export function defaultPgliteDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? (env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'))
  return path.join(base, 'collabdocs', 'pglite')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const production = env.NODE_ENV === 'production'
  const jwtSecret = env.JWT_SECRET ?? (production ? '' : 'dev-insecure-secret-change-me')
  if (!jwtSecret) throw new Error('JWT_SECRET must be set in production')
  return {
    port: num(env.PORT, 4000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR ? path.resolve(env.PGLITE_DIR) : defaultPgliteDir(env),
    redisUrl: env.REDIS_URL || undefined,
    jwtSecret,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    clientDist: env.CLIENT_DIST || undefined,
    instanceId: env.INSTANCE_ID ?? `${os.hostname()}-${process.pid}`,
    flushIntervalMs: num(env.FLUSH_INTERVAL_MS, 50),
    snapshotEveryFlushes: num(env.SNAPSHOT_EVERY_FLUSHES, 100),
    snapshotIntervalMs: num(env.SNAPSHOT_INTERVAL_MS, 60_000),
    roomIdleMs: num(env.ROOM_IDLE_MS, 10_000),
    authRateLimit: num(env.AUTH_RATE_LIMIT, production ? 100 : 0),
    wsRateLimit: num(env.WS_RATE_LIMIT, 100),
    processMetrics: env.PROCESS_METRICS !== 'false',
    logLevel: (env.LOG_LEVEL as Config['logLevel']) ?? 'info',
    ...overrides,
  }
}
