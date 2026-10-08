import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  auditNewsProtocolReadOnly,
  getFinalizerFailureDiagnostic,
  type FinalizerClient,
  type NewsProtocolAuditReport,
} from './finalize-news-protocol'
import { parseObserverDatabaseUrl } from './news-protocol-observer-contract'

const require = createRequire(import.meta.url)

export async function runNewsProtocolAudit(
  env: Record<string, string | undefined> = process.env,
  suppliedClient?: FinalizerClient,
): Promise<NewsProtocolAuditReport> {
  const url = parseObserverDatabaseUrl(env.CMS_OBSERVER_DATABASE_URL)
  let client = suppliedClient
  if (!client) {
    const { Client } = require('pg') as { Client: new (options: object) => FinalizerClient }
    client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 })
  }
  let primaryError: unknown
  let report: NewsProtocolAuditReport | undefined
  try {
    await client.connect()
    report = await auditNewsProtocolReadOnly(client)
  } catch (error) {
    primaryError = error
  }
  try {
    await client.end()
  } catch {
    if (primaryError === undefined) primaryError = Object.assign(new Error('observer_client_close_failed'), { code: 'database_error' })
  }
  if (primaryError !== undefined) throw primaryError
  if (!report) throw Object.assign(new Error('observer_audit_result_unavailable'), { code: 'database_error' })
  return report
}

function safeFailure(error: unknown): { phase: string; reason: string; sqlstate: string | null } {
  const diagnostic = getFinalizerFailureDiagnostic(error)
  if (diagnostic) return {
    phase: diagnostic.phase,
    reason: diagnostic.reason,
    sqlstate: diagnostic.sqlstate,
  }
  let code: unknown
  try {
    code = error && (typeof error === 'object' || typeof error === 'function')
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null
  } catch { code = null }
  const reason = code === 'observer_database_url_required' || code === 'unsafe_observer_database_url'
    ? code : 'database_error'
  return { phase: 'observer-connect', reason, sqlstate: null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--audit-protocol') {
    console.error(JSON.stringify({ status: 'NOT_RUN', reason: 'usage', command: '--audit-protocol' }))
    process.exitCode = 2
  } else {
    runNewsProtocolAudit().then(report => {
      console.log(JSON.stringify(report))
    }).catch(error => {
      console.error(JSON.stringify({ status: 'FAIL', ...safeFailure(error) }))
      process.exitCode = 1
    })
  }
}
