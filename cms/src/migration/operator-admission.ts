import { createLocalReq, type Payload } from 'payload'
import { readCmsEnvironment } from '../config/environment'
import { createPortalClient } from '../auth/portal-client'
import { projectVerifiedNewsEditor } from '../auth/portal-strategy'
import type { VerifiedPortalActor } from '../contracts/news'
import { assertImportBinding } from './identity'
import { applyNewsImport, type ApplyNewsImportOptions, type LoadedNewsImportBundle } from './import-news'
import { planLoadedNewsImport } from './plan'
import { claimImportPreflightArtifact } from './preflight'
import { assertPayloadTargetBinding, withOperatorImportCapability,
  type ImportOperatorIdentity } from './target-binding'

type OperatorPortalClient = Pick<ReturnType<typeof createPortalClient>, 'checkPortalActor' | 'getAuthority'>

export type FrozenNewsImportAdmission = {
  /** Exact in-process result from runImportPreflight; serialized copies cannot be consumed. */
  preflight: unknown
  payload: Payload
  actorUid: string
  runId: string
  manifestSha256: string
  expectedEpoch: number
}

/** Fresh strict v1 actor and current Portal authority; v2 admin actors are not accepted here. */
export async function assertOperatorPortalState(client: OperatorPortalClient, actorUid: string,
  expectedEpoch: number): Promise<VerifiedPortalActor> {
  if (typeof actorUid !== 'string' || !actorUid || actorUid.length > 128 ||
    !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || expectedEpoch >= 2147483647) {
    throw new Error('import_operator_actor_invalid')
  }
  const actor = await client.checkPortalActor(actorUid)
  if (actor.uid !== actorUid || actor.canManageNews !== true) throw new Error('editorial_permission_denied')
  const authority = await client.getAuthority()
  if (authority.mode !== 'frozen' || authority.epoch !== expectedEpoch) {
    throw new Error('cms_preparation_authority_conflict')
  }
  return actor
}

function requireLoadedBundle(value: unknown): LoadedNewsImportBundle {
  if (!value || typeof value !== 'object') throw new Error('import_bundle_load_failed')
  const bundle = value as Record<string, unknown>
  if (!bundle.manifest || typeof bundle.manifest !== 'object' || typeof bundle.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(bundle.manifestSha256) || !(bundle.revisionById instanceof Map) ||
    !(bundle.assetPaths instanceof Map)) throw new Error('import_bundle_load_failed')
  return value as LoadedNewsImportBundle
}

/**
 * Server-local Gate 4 Unit 1A primitive only. It is deliberately not wired to an
 * HTTP endpoint or CLI; its caller must already possess the live Payload runtime.
 */
export async function applyFrozenNewsImport(admission: FrozenNewsImportAdmission) {
  if (!admission || typeof admission !== 'object') throw new Error('import_operator_admission_invalid')
  // Read caller-owned fields exactly once, synchronously, before any await. Keep
  // the Payload runtime by reference; cloning Payload/adapter internals is unsafe.
  const { preflight, payload, actorUid, runId, manifestSha256, expectedEpoch } = admission
  const snapshot = Object.freeze({ preflight, payload, actorUid, runId, manifestSha256, expectedEpoch })

  assertImportBinding({ runId: snapshot.runId, manifestSha256: snapshot.manifestSha256,
    authorityEpoch: snapshot.expectedEpoch })
  if (!snapshot.payload || typeof snapshot.payload !== 'object' || typeof snapshot.actorUid !== 'string' ||
    !snapshot.actorUid || snapshot.actorUid.length > 128) {
    throw new Error('import_operator_actor_invalid')
  }
  if (snapshot.expectedEpoch >= 2147483647) throw new Error('cms_preparation_authority_conflict')

  const artifact = claimImportPreflightArtifact(snapshot.preflight)
  if (artifact.manifestSha256 !== snapshot.manifestSha256 || artifact.expectedEpoch !== snapshot.expectedEpoch) {
    throw new Error('import_preflight_binding_mismatch')
  }
  const bundle = requireLoadedBundle(artifact.bundle)
  const { manifest } = bundle
  if (bundle.manifestSha256 !== artifact.manifestSha256 || manifest.source.authority.mode !== 'frozen' ||
    manifest.source.authority.epoch !== artifact.expectedEpoch || manifest.source.instanceId !== artifact.sourceInstance) {
    throw new Error('import_bundle_identity_mismatch')
  }
  if (planLoadedNewsImport(bundle, []).sourceFingerprint !== artifact.sourceFingerprint) {
    throw new Error('import_bundle_identity_mismatch')
  }
  if ((snapshot.payload.db as typeof snapshot.payload.db & { allowIDOnCreate?: boolean }).allowIDOnCreate !== true) {
    throw new Error('legacy_import_requires_separate_import_config')
  }

  // Provenance is checked against the configured adapter and filesystem before
  // editor projection or any import/content side effect.
  await assertPayloadTargetBinding(snapshot.payload, artifact)
  const environment = readCmsEnvironment(process.env)
  const actor = await assertOperatorPortalState(createPortalClient(environment), snapshot.actorUid, snapshot.expectedEpoch)
  const editor = await projectVerifiedNewsEditor(snapshot.payload, actor)
  if (!editor || editor.portalUid !== actor.uid || typeof editor.id !== 'string' || !editor.id) {
    throw new Error('import_operator_projection_invalid')
  }

  // This is the existing verified actor plus its persisted Portal projection,
  // constructed with Payload's pinned Local API request factory (never caller UID casting).
  const user = { ...editor, collection: 'portal-editors' as const, portalActor: actor }
  const req = await createLocalReq({ user }, snapshot.payload)
  const identity: ImportOperatorIdentity = Object.freeze({ actorUid: snapshot.actorUid, runId: snapshot.runId,
    manifestSha256: snapshot.manifestSha256, expectedEpoch: snapshot.expectedEpoch })
  const options: ApplyNewsImportOptions = { payload: snapshot.payload, req, bundle,
    manifestSha256: snapshot.manifestSha256, uploadDir: artifact.targetUploadDir,
    sourceFingerprint: artifact.sourceFingerprint, expectedEpoch: snapshot.expectedEpoch,
    runId: snapshot.runId, actorUid: snapshot.actorUid }
  return withOperatorImportCapability(req, snapshot.payload, bundle, artifact, identity,
    () => applyNewsImport(options))
}
