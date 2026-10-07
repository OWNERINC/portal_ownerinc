import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { assertImportApplyReady, runImportPreflight } from '../src/migration/preflight'
import type { ImportClientFactory } from '../src/migration/database-preflight'

function safeCode(error: unknown) {
  const message = (error as { code?: unknown; message?: unknown })?.code ?? (error as { message?: unknown })?.message
  return typeof message === 'string' && /^[a-z][a-z0-9_]{1,79}$/u.test(message) ? message : 'import_preflight_failed'
}

export async function main(args: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env,
  dependencies: { createClient?: ImportClientFactory; now?: Date } = {}) {
  try {
    const preflight = await runImportPreflight(args, { env, ...dependencies })
    if (preflight.applyRequested) assertImportApplyReady(preflight)
    return { phase: 'preflight' as const, destinationReconciled: false,
      expectedEntities: preflight.expectedEntities,
      exceptionCount: preflight.exceptions.length, sourceHasExceptions: preflight.sourceHasExceptions,
      manifestSha256: preflight.manifestSha256, sourceFingerprint: preflight.sourceFingerprint,
      sourceDatabaseIdentitySha256: preflight.databases.sourceIdentitySha256,
      targetDatabaseIdentitySha256: preflight.databases.targetIdentitySha256 }
  } catch (error) {
    throw new Error(safeCode(error))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ code: safeCode(error) })); process.exitCode = 1 })
}
