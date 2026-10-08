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

test('CMS image pins Node and rebuilds the matching upstream esbuild source with a patched Go toolchain', async () => {
  const [dockerfile, dockerignore, packageJsonText, lockText, goMod, goSum, compose, runtimePackaging, apiPackageText, apiLockText] = await Promise.all([
    read('cms/Dockerfile'), read('cms/Dockerfile.dockerignore'), read('cms/package.json'), read('cms/package-lock.json'),
    read('cms/go-build/go.mod'), read('cms/go-build/go.sum'), read('docker-compose.payload.yml'),
    read('cms/scripts/check-runtime-packaging.mjs'), read('api/package.json'), read('api/package-lock.json'),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const lock = JSON.parse(lockText);
  const apiPackage = JSON.parse(apiPackageText);
  const apiLock = JSON.parse(apiLockText);
  const pinnedBase = /^FROM node:24-alpine3\.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS /gm;
  assert.equal((dockerfile.match(pinnedBase) || []).length, 3,
    'all independent CMS base stages must pin the current Node 24 Alpine registry index digest');
  assert.equal((dockerfile.match(/apk upgrade --no-cache/g) || []).length, 3,
    'each independent base filesystem must apply Alpine security updates');
  assert.equal((dockerfile.match(/npm install --global npm@12\.2\.0/g) || []).length, 3,
    'keep the required npm CLI while replacing the vulnerable bundled npm version');
  assert.equal((dockerfile.match(/brace-expansion@5\.0\.11/g) || []).length, 3,
    'replace npm 12.2.0 bundled brace-expansion in every independent image stage');
  assert.equal((dockerfile.match(/undici@6\.28\.1/g) || []).length, 3,
    'replace npm 12.2.0 bundled undici with its Trivy-fixed compatible release');
  assert.match(dockerfile, /npm ci --omit=dev --omit=optional/,
    'the embedded API graph must omit optional Firebase/Firestore dependencies');
  assert.match(dockerfile, /@img\/sharp-linuxmusl-x64@0\.35\.5[\s\S]*@img\/sharp-libvips-linuxmusl-x64@1\.3\.4/,
    'restore the API lockfile-matched Sharp musl runtime packages explicitly');
  assert.match(dockerfile, /CMD \["npm", "start"\]/,
    'npm remains the production startup command');
  assert.match(dockerfile, /FROM --platform=\$BUILDPLATFORM golang:1\.26\.6-alpine3\.23@sha256:e57c41c1d5864341031181b0db34b9a537bb5773eb6428e4e5bdaea0f9135406 AS esbuild-builder/,
    'esbuild must be built from a registry-pinned official Go 1.26.6 toolchain');
  assert.match(dockerfile, /GOPROXY=https:\/\/proxy\.golang\.org GOSUMDB=sum\.golang\.org/,
    'Go dependencies must use the public proxy and checksum database');
  assert.match(dockerfile, /go build -mod=readonly -trimpath -buildvcs=false[\s\S]*github\.com\/evanw\/esbuild\/cmd\/esbuild/,
    'rebuild only the versioned upstream esbuild command with locked Go module sums');
  assert.match(dockerfile, /go version -m \/out\/esbuild[\s\S]*A2uETn4jrQTcXaT\/shwTDTYBxDjl7fV7nXmUrJxfA2w=/,
    'the built executable must embed the verified upstream v0.28.2 module sum');
  assert.equal((dockerfile.match(/COPY --from=esbuild-builder(?: --chown=node:node)? \/out\/esbuild/g) || []).length, 2,
    'use the rebuilt binary for the Next build and final CMS runtime');
  assert.match(dockerignore, /!cms\/go-build\/go\.mod[\s\S]*!cms\/go-build\/go\.sum/,
    'the Docker context must allow only the pinned Go module manifests');
  assert.match(goMod, /require github\.com\/evanw\/esbuild v0\.28\.2/u);
  assert.match(goSum, /github\.com\/evanw\/esbuild v0\.28\.2 h1:A2uETn4jrQTcXaT\/shwTDTYBxDjl7fV7nXmUrJxfA2w=/u);
  assert.match(goSum, /golang\.org\/x\/sys v0\.0\.0-20220715151400-c0bba94af5f8 h1:0A\+M6Uqn\+Eje4kHMK80dtF3JCXC4ykBgQG4Fe06QRhQ=/u);
  const builder = dockerfile.slice(dockerfile.indexOf('FROM --platform=$BUILDPLATFORM golang:'), dockerfile.indexOf('\n\nFROM sources'));
  assert.match(builder, /GOTOOLCHAIN=local CGO_ENABLED=0/,
    'use only the pinned toolchain and build a static Linux executable');
  assert.match(builder, /test "\$TARGETOS\/\$TARGETARCH" = "linux\/amd64"/,
    'fail closed instead of copying the x64 replacement into another target architecture');
  assert.match(builder, /GOOS="\$TARGETOS" GOARCH="\$TARGETARCH" go build -mod=readonly -trimpath -buildvcs=false/,
    'cross-build the explicit target reproducibly without ambient VCS metadata');
  assert.doesNotMatch(builder, /(?:-ldflags|(?:^|\s)-s(?:\s|$)|(?:^|\s)-w(?:\s|$))/,
    'do not strip Go build information used for toolchain and module attestation');
  assert.match(builder, /test "\$\(\/out\/esbuild --version\)" = "0\.28\.2"/,
    'the replacement executable must report the same version as the locked JavaScript package');
  assert.match(builder, /go version -m \/out\/esbuild \| grep -F 'go1\.26\.6'[\s\S]*go version -m \/out\/esbuild \| grep -F 'v0\.28\.2'[\s\S]*go version -m \/out\/esbuild \| grep -F 'h1:A2uETn4jrQTcXaT\/shwTDTYBxDjl7fV7nXmUrJxfA2w='/,
    'attest the embedded Go toolchain, exact upstream module release, and verified module checksum');
  assert.match(runtimePackaging, /esbuild\.transformSync\('const answer: number = 42'/,
    'final image smoke exercises the rebuilt executable through the locked esbuild JavaScript API');
  assert.match(runtimePackaging, /--import', 'tsx', tsxSmokeFile/,
    'final image smoke runs a real TypeScript file through the retained TSX runtime and esbuild');
  assert.match(runtimePackaging, /node_modules\/payload\/bin\.js/,
    'the final image invokes the Payload CLI needed by migrations');
  assert.match(runtimePackaging, /payloadCli, 'info'/,
    'the Payload CLI smoke runs without connecting to a database');
  assert.match(compose, /npm run migrate/,
    'the migration service continues to invoke the Payload migration script through npm');
  assert.equal(packageJson.dependencies.tsx, '4.23.15');
  assert.equal(packageJson.overrides.tsx, '$tsx', 'all transitive tsx copies must match the direct runtime dependency');
  assert.equal(packageJson.overrides.esbuild, '0.28.2', 'all esbuild copies must use the current upstream release');
  assert.equal(apiPackage.overrides['@fastify/busboy'], '3.2.2',
    'the one actual Firebase Admin production advisory in the embedded API graph uses its fixed version');
  assert.equal(apiPackage.overrides['@grpc/grpc-js'], '1.14.5');
  assert.equal(apiPackage.overrides['brace-expansion'], '2.1.6');
  assert.equal(apiLock.packages['node_modules/@fastify/busboy'].version, '3.2.2');
  assert.equal(apiLock.packages['node_modules/@grpc/grpc-js'].version, '1.14.5');
  assert.equal(apiLock.packages['node_modules/brace-expansion'].version, '2.1.6');

  const tsxPackages = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/tsx$/.test(path));
  assert.ok(tsxPackages.length > 0, 'the package graph must retain the TSX runtime');
  for (const [path, entry] of tsxPackages) assert.equal(entry.version, '4.23.15', path);
  const esbuildPackages = Object.entries(lock.packages).filter(([path]) =>
    /(?:^|\/)node_modules\/(?:esbuild|@esbuild\/[^/]+)$/.test(path));
  assert.ok(esbuildPackages.some(([path]) => path === 'node_modules/@esbuild/linux-x64' || path.endsWith('/node_modules/@esbuild/linux-x64')),
    'the lockfile must retain the Linux x64 esbuild binary');
  assert.equal(esbuildPackages.filter(([path]) => path.startsWith('node_modules/@esbuild/')).length, 26,
    'retain all esbuild platform packages in the lockfile while unifying their versions');
  for (const [path, entry] of esbuildPackages) assert.equal(entry.version, '0.28.2', path);
});
