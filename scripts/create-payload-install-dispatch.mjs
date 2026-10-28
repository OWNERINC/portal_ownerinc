import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  parseEvidenceJson, validateQualifiedCandidate, validateProductionAuthorization, validateRunIdentity,
} from './lib/payload-candidate-qualification.mjs';

const idPattern = /^[1-9][0-9]{0,19}$/u;
const artifactDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const imagePatterns = Object.freeze({
  api: /^ghcr\.io\/ownerinc\/ownerinc-portal-api@sha256:[0-9a-f]{64}$/u,
  cron: /^ghcr\.io\/ownerinc\/ownerinc-portal-cron@sha256:[0-9a-f]{64}$/u,
  cms: /^ghcr\.io\/ownerinc\/ownerinc-portal-cms@sha256:[0-9a-f]{64}$/u,
});
const roles = Object.freeze(['candidate', 'qualified', 'report']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const deny = () => { throw new Error('invalid_payload_install_dispatch'); };

export function createPayloadInstallDispatch({ candidateBytes, qualifiedBytes, reportBytes, artifactIds, artifactDigests }) {
  const candidate = parseEvidenceJson(candidateBytes);
  if (candidate.schemaVersion !== 2) deny();
  validateRunIdentity({ commit: candidate.commit, runId: candidate.runId, runAttempt: candidate.runAttempt });
  validateProductionAuthorization(candidate.authorization);
  if (!candidate.images || Object.keys(candidate.images).sort().join(',') !== 'api,cms,cron' ||
      Object.entries(imagePatterns).some(([name, pattern]) => !pattern.test(candidate.images[name] || ''))) deny();
  validateQualifiedCandidate({
    candidateBytes, qualifiedBytes, reportBytes,
    expectedRun: { commit: candidate.commit, runId: candidate.runId, runAttempt: candidate.runAttempt },
    expectedImages: candidate.images, expectedAuthorization: candidate.authorization,
  });
  if (!artifactIds || !artifactDigests || Object.keys(artifactIds).sort().join(',') !== roles.slice().sort().join(',') ||
      Object.keys(artifactDigests).sort().join(',') !== roles.slice().sort().join(',') ||
      roles.some(role => !idPattern.test(artifactIds[role] || '') || !artifactDigestPattern.test(artifactDigests[role] || '')) ||
      new Set(Object.values(artifactIds)).size !== roles.length) deny();
  const inputs = {
    commit: candidate.commit,
    run_id: candidate.runId,
    run_attempt: candidate.runAttempt,
    api_image: candidate.images.api,
    cron_image: candidate.images.cron,
    cms_image: candidate.images.cms,
    candidate_artifact_id: artifactIds.candidate,
    candidate_artifact_digest: artifactDigests.candidate,
    candidate_sha256: sha256(candidateBytes),
    qualified_artifact_id: artifactIds.qualified,
    qualified_artifact_digest: artifactDigests.qualified,
    qualified_sha256: sha256(qualifiedBytes),
    report_artifact_id: artifactIds.report,
    report_artifact_digest: artifactDigests.report,
    report_sha256: sha256(reportBytes),
    approval_sha256: candidate.authorization.approvalSha256,
    inventory_identity: candidate.authorization.inventoryIdentity,
    expires_at: candidate.authorization.expiresAt,
    nonce: candidate.authorization.nonce,
  };
  return { schemaVersion: 1, kind: 'payload-private-install-dispatch-v1',
    qualificationContract: 'payload-private-install-v2', installationWorkflow: '.github/workflows/payload-install-production.yml', inputs };
}

async function main() {
  if (process.argv.length !== 2) deny();
  const report = process.env.RECOVERY_REPORT;
  const output = process.env.INSTALL_DISPATCH_OUTPUT;
  if (!report || !output || !process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) deny();
  const value = createPayloadInstallDispatch({
    candidateBytes: await readFile('candidate.json'),
    qualifiedBytes: await readFile('qualified-candidate.json'),
    reportBytes: await readFile(report),
    artifactIds: { candidate: process.env.CANDIDATE_ARTIFACT_ID, qualified: process.env.QUALIFIED_ARTIFACT_ID,
      report: process.env.REPORT_ARTIFACT_ID },
    artifactDigests: { candidate: process.env.CANDIDATE_ARTIFACT_DIGEST, qualified: process.env.QUALIFIED_ARTIFACT_DIGEST,
      report: process.env.REPORT_ARTIFACT_DIGEST },
  });
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await appendFile(process.env.GITHUB_OUTPUT,
    Object.entries(value.inputs).map(([name, selected]) => `${name}=${selected}\n`).join(''));
  const flags = Object.entries(value.inputs).map(([name, selected]) => `  -f ${name}=${selected} \\`).join('\n');
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Qualified private-install handoff\n\nVerify the downloaded \`install-dispatch.json\` byte-for-byte; never infer a value.\n\n` +
    `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n` +
    `\`\`\`sh\ngh workflow run payload-install-production.yml --ref main \\\n${flags.slice(0, -2)}\n\`\`\`\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(() => { console.error('payload_install_dispatch_denied'); process.exitCode = 1; });
}
