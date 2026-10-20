import type { Server } from 'node:http'

export type LocalActorConfig = { runId: string }
export function createLocalActorTransport(config: LocalActorConfig, serviceSecret: string): Server
