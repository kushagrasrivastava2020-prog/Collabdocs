import type { Config } from './config.js'
import type { Db } from './db/index.js'
import type { DocStore } from './collab/persistence.js'
import type { CollabServer } from './collab/server.js'
import type { Logger } from './util/log.js'

/** Shared dependencies handed to every router. */
export interface Ctx {
  config: Config
  db: Db
  store: DocStore
  collab: CollabServer
  log: Logger
}
