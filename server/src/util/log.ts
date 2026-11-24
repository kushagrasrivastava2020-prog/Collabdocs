import type { Config } from '../config.js'

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void
  debug(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
}

export function createLogger(config: Pick<Config, 'logLevel' | 'instanceId'>): Logger {
  const emit = (level: string, msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, instance: config.instanceId, msg, ...extra })
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return {
    info: (m, e) => config.logLevel !== 'silent' && emit('info', m, e),
    debug: (m, e) => config.logLevel === 'debug' && emit('debug', m, e),
    error: (m, e) => emit('error', m, e),
  }
}
