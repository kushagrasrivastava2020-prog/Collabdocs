import { loadConfig } from './config.js'
import { createApp } from './app.js'

const config = loadConfig()
const app = await createApp(config)
const port = await app.listen()
app.ctx.log.info('CollabDocs server listening', {
  port,
  db: app.ctx.db.kind,
  pubsub: config.redisUrl ? 'redis' : 'memory',
})

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  app.ctx.log.info('shutting down', { signal })
  const force = setTimeout(() => process.exit(1), 15_000)
  force.unref()
  try {
    await app.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
