import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

function namedStep(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

function containingStep(workflow, marker) {
  const index = workflow.indexOf(marker);
  assert.notEqual(index, -1, `missing workflow marker: ${marker}`);
  const start = workflow.lastIndexOf('      - ', index);
  const end = workflow.indexOf('\n      - ', index);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

test('CI builds, scans, and publishes a separate immutable Payload CMS image artifact', async () => {
  const [workflow, dockerfile, deployment] = await Promise.all([
    read('.github/workflows/ci.yml'), read('cms/Dockerfile'), read('docs/operations/deployment.md'),
  ]);
  const build = namedStep(workflow, 'Build production images');
  const scan = namedStep(workflow, 'Scan CMS image');
  const publish = namedStep(workflow, 'Publish immutable images');
  const publishAt = workflow.indexOf('      - name: Publish immutable images');
  const scanAt = workflow.indexOf('      - name: Scan CMS image');
  const buildAt = workflow.indexOf('      - name: Build production images');

  assert.ok(buildAt < scanAt && scanAt < publishAt, 'build and blocking scan must precede image publication');
  assert.match(build, /docker build --tag ownerinc-portal-cms:\$\{GITHUB_SHA\} --file cms\/Dockerfile \./,
    'CMS Dockerfile must be built with the repository-root context');
  assert.doesNotMatch(build, /--build-arg|CMS_BUILD_ONLY|secrets\./,
    'production CMS image build must not receive build-time secrets or the synthetic CI build flag');
  assert.match(dockerfile, /RUN node --import tsx scripts\/check-runtime-packaging\.mjs/,
    'the existing final-runtime packaging closure check must run as part of the production image build');

  assert.match(scan, /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
  assert.match(scan, /image-ref: ownerinc-portal-cms:\$\{\{ github\.sha \}\}/);
  assert.match(scan, /severity: HIGH,CRITICAL[\s\S]*ignore-unfixed: true[\s\S]*exit-code: 1/);

  assert.match(workflow, /cms_image: \$\{\{ steps\.publish\.outputs\.cms_image \}\}/,
    'the validated image digest must be exposed as a validate job output');
  assert.match(publish, /docker tag ownerinc-portal-cms:\$\{GITHUB_SHA\} \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}/);
  assert.match(publish, /docker push \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}/);
  assert.match(publish, /if: \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'/,
    'CMS images may publish only on the protected main ref, never on pull requests');
  assert.match(publish, /cms_image=\$\(docker inspect --format='\{\{index \.RepoDigests 0\}\}' \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}\)/);
  assert.match(publish, /\^ghcr\\\.io\/ownerinc\/ownerinc-portal-cms@sha256:\[0-9a-f\]\{64\}\$/,
    'only the complete expected GHCR repository@sha256 reference may be exported');
  assert.match(publish, /printf '%s\\n' "\$cms_image" > cms-image-digest\.txt/);
  assert.match(publish, /printf '%s\\n' "\$GITHUB_SHA" > cms-image-source\.txt/);
  assert.match(publish, /echo "cms_image=\$cms_image" >> "\$GITHUB_OUTPUT"/);
  const legacyDigestWrites = publish.match(/docker inspect[^\n]*image-digests\.txt/g) || [];
  assert.equal(legacyDigestWrites.length, 2, 'the legacy release digest file must remain exactly API and cron');
  assert.match(legacyDigestWrites[0], /ownerinc-portal-api/);
  assert.match(legacyDigestWrites[1], /ownerinc-portal-cron/);

  const upload = containingStep(workflow, 'name: cms-image-digest');
  assert.match(upload, /if: \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'/);
  assert.match(upload, /path:[\s\S]*cms-image-digest\.txt[\s\S]*cms-image-source\.txt/);
  const legacyUpload = containingStep(workflow, 'name: image-digests');
  assert.match(legacyUpload, /path: image-digests\.txt/);
  assert.doesNotMatch(legacyUpload, /cms-image|cms_image/,
    'CMS metadata must not alter the existing API/cron digest artifact');

  const productionDeploy = workflow.slice(workflow.indexOf('  deploy-production:'));
  assert.doesNotMatch(productionDeploy, /cms_image|cms-image/,
    'the production receiver must continue receiving only its existing API/cron release contract');
  assert.match(productionDeploy, /printf '%s\\n%s\\n' "\$API_IMAGE" "\$CRON_IMAGE" > \.ci-images/,
    'the production release manifest must continue containing only API and cron digests');
  assert.match(deployment, /publicação e artefato de digest separados, ainda sem consumo pelo deploy automático/i);
  assert.match(deployment, /não ativa nem implanta o Payload CMS em produção/i);
});
