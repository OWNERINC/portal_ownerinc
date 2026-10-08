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

function condition(block, indentation) {
  const prefix = `${' '.repeat(indentation)}if: `;
  const line = block.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  assert.ok(line, `missing if condition at indentation ${indentation}`);
  const value = line.slice(prefix.length);
  if (value !== '>-') return value;

  const marker = `${prefix}>-\n`;
  const start = block.indexOf(marker);
  const contentIndent = ' '.repeat(indentation + 2);
  const lines = block.slice(start + marker.length).split(/\r?\n/);
  const expression = [];
  for (const line of lines) {
    if (!line.startsWith(contentIndent)) break;
    expression.push(line.trim());
  }
  return expression.join(' ');
}

test('CI builds, scans, and publishes a separate immutable Payload CMS image artifact', async () => {
  const [workflow, dockerfile, deployment] = await Promise.all([
    read('.github/workflows/ci.yml'), read('cms/Dockerfile'), read('docs/operations/deployment.md'),
  ]);
  const build = namedStep(workflow, 'Build production images');
  const scan = namedStep(workflow, 'Scan CMS image');
  const publish = namedStep(workflow, 'Publish immutable images');
  const publishCms = namedStep(workflow, 'Publish CMS immutable image');
  const authenticate = namedStep(workflow, 'Authenticate to GHCR');
  const publishAt = workflow.indexOf('      - name: Publish CMS immutable image');
  const scanAt = workflow.indexOf('      - name: Scan CMS image');
  const buildAt = workflow.indexOf('      - name: Build production images');
  const normalMainCondition = "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && inputs.cms_image_only != true";
  const cmsPublishCondition = `(${normalMainCondition}) || (github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && inputs.cms_image_only == true)`;

  assert.ok(buildAt < scanAt && scanAt < publishAt, 'build and blocking scan must precede image publication');
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+cms_image_only:\n\s+description:[^\n]*\n\s+required: false\n\s+type: boolean\n\s+default: false/,
    'the opt-in CMS-only dispatch must be a default-false boolean input');
  assert.match(build, /docker build --tag ownerinc-portal-cms:\$\{GITHUB_SHA\} --file cms\/Dockerfile \./,
    'CMS Dockerfile must be built with the repository-root context');
  assert.doesNotMatch(build, /--build-arg|CMS_BUILD_ONLY|secrets\./,
    'production CMS image build must not receive build-time secrets or the synthetic CI build flag');
  assert.match(dockerfile, /RUN node --import tsx scripts\/check-runtime-packaging\.mjs/,
    'the existing final-runtime packaging closure check must run as part of the production image build');

  assert.match(scan, /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
  assert.match(scan, /image-ref: ownerinc-portal-cms:\$\{\{ github\.sha \}\}/);
  assert.match(scan, /severity: HIGH,CRITICAL[\s\S]*ignore-unfixed: true[\s\S]*exit-code: 1/);

  assert.match(workflow, /cms_image: \$\{\{ steps\.publish_cms\.outputs\.cms_image \}\}/,
    'the CMS-only publication step must expose its digest as a validate job output');
  assert.equal(condition(authenticate, 8), cmsPublishCondition,
    'GHCR authentication must be limited to normal main publication or explicit branch CMS-only dispatch');
  assert.equal(condition(publish, 8), normalMainCondition,
    'API/cron image publication must remain main-only and disabled in CMS-only mode');
  const legacyPublishCommands = publish.match(/        run: \|\n([\s\S]*)$/)?.[1] || '';
  assert.doesNotMatch(legacyPublishCommands, /ownerinc-portal-cms|cms_image|cms-image/,
    'the legacy publisher must publish only API and cron');
  assert.equal(condition(publishCms, 8), cmsPublishCondition,
    'CMS publication may run on normal main publication or explicit branch CMS-only dispatch');
  assert.match(publishCms, /docker tag ownerinc-portal-cms:\$\{GITHUB_SHA\} \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}/);
  assert.match(publishCms, /docker push \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}/);
  assert.match(publishCms, /cms_image=\$\(docker inspect --format='\{\{index \.RepoDigests 0\}\}' \$\{REGISTRY\}\/ownerinc-portal-cms:\$\{GITHUB_SHA\}\)/);
  assert.match(publishCms, /\^ghcr\\\.io\/ownerinc\/ownerinc-portal-cms@sha256:\[0-9a-f\]\{64\}\$/,
    'only the complete expected GHCR repository@sha256 reference may be exported');
  assert.match(publishCms, /printf '%s\\n' "\$cms_image" > cms-image-digest\.txt/);
  assert.match(publishCms, /printf '%s\\n' "\$GITHUB_SHA" > cms-image-source\.txt/);
  assert.match(publishCms, /echo "cms_image=\$cms_image" >> "\$GITHUB_OUTPUT"/);
  const legacyDigestWrites = publish.match(/docker inspect[^\n]*image-digests\.txt/g) || [];
  assert.equal(legacyDigestWrites.length, 2, 'the legacy release digest file must remain exactly API and cron');
  assert.match(legacyDigestWrites[0], /ownerinc-portal-api/);
  assert.match(legacyDigestWrites[1], /ownerinc-portal-cron/);

  const upload = containingStep(workflow, 'name: cms-image-digest');
  assert.equal(condition(upload, 8), cmsPublishCondition);
  assert.match(upload, /path:[\s\S]*cms-image-digest\.txt[\s\S]*cms-image-source\.txt/);
  const legacyUpload = containingStep(workflow, 'name: image-digests');
  assert.equal(condition(legacyUpload, 8), normalMainCondition);
  assert.match(legacyUpload, /path: image-digests\.txt/);
  assert.doesNotMatch(legacyUpload, /cms-image|cms_image(?!_only)/,
    'CMS metadata must not alter the existing API/cron digest artifact');

  const productionDeploy = workflow.slice(workflow.indexOf('  deploy-production:'));
  assert.equal(condition(productionDeploy, 4), normalMainCondition,
    'production deployment must never run in CMS-only mode');
  assert.doesNotMatch(productionDeploy, /cms_image(?!_only)|cms-image/,
    'the production receiver must continue receiving only its existing API/cron release contract');
  assert.match(productionDeploy, /printf '%s\\n%s\\n' "\$API_IMAGE" "\$CRON_IMAGE" > \.ci-images/,
    'the production release manifest must continue containing only API and cron digests');
  assert.match(deployment, /publicação e artefato de digest separados, ainda sem consumo pelo deploy automático/i);
  assert.match(deployment, /não ativa nem implanta o Payload CMS em produção/i);

  const policy = ({ event, ref, cmsImageOnly }) => {
    const legacy = (event === 'push' || event === 'workflow_dispatch') &&
      ref === 'refs/heads/main' && cmsImageOnly !== true;
    const cms = legacy || (event === 'workflow_dispatch' && ref.startsWith('refs/heads/') && cmsImageOnly === true);
    return { legacy, cms, deploy: legacy };
  };
  const scenarios = [
    [{ event: 'pull_request', ref: 'refs/pull/42/merge', cmsImageOnly: false }, { legacy: false, cms: false, deploy: false }],
    [{ event: 'push', ref: 'refs/heads/main', cmsImageOnly: false }, { legacy: true, cms: true, deploy: true }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/main', cmsImageOnly: false }, { legacy: true, cms: true, deploy: true }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/main', cmsImageOnly: true }, { legacy: false, cms: true, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/feat/payload-cms-final', cmsImageOnly: true }, { legacy: false, cms: true, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/heads/feat/payload-cms-final', cmsImageOnly: false }, { legacy: false, cms: false, deploy: false }],
    [{ event: 'workflow_dispatch', ref: 'refs/tags/v1', cmsImageOnly: true }, { legacy: false, cms: false, deploy: false }],
  ];
  for (const [context, expected] of scenarios) {
    assert.deepEqual(policy(context), expected, `${context.event} ${context.ref} cms_image_only=${context.cmsImageOnly}`);
  }
});
