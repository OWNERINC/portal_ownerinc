import { canonicalObservedCheckDefinition } from '../../cms/scripts/finalize-news-protocol.ts'
import { fingerprintLogicalSnapshot, LOGICAL_SNAPSHOT_MAX_BYTES, logicalSnapshotErrorCodes } from './payload-logical-snapshot.mjs'

async function main() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk)
    bytes += value.length
    if (bytes > LOGICAL_SNAPSHOT_MAX_BYTES) throw new Error('logical_snapshot_limit_exceeded')
    chunks.push(value)
  }
  process.stdout.write(JSON.stringify(fingerprintLogicalSnapshot(Buffer.concat(chunks), canonicalObservedCheckDefinition)))
}
void main().catch(error => {
  const code = error instanceof Error && logicalSnapshotErrorCodes.includes(error.message)
    ? error.message : 'logical_snapshot_failed'
  process.stderr.write(`${code}\n`)
  process.exitCode = 2
})
