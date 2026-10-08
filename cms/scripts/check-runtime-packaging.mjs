import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Run in the final image during build. Imports only the pure consumer/producer
// closure; NEVER load payload.config/getPayload or execute import/export/cutover.
export async function checkRuntimePackaging() {
  const root = new URL('../../', import.meta.url);
  const apiRequire = createRequire(new URL('api/package.json', root));
  const cmsRequire = createRequire(new URL('cms/package.json', root));
  assert.equal(typeof apiRequire('pg').Client, 'function');
  const sharp = apiRequire('sharp');
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal((await sharp(png).metadata()).format, 'png');
  assert.ok(cmsRequire.resolve('payload'));
  assert.ok(cmsRequire.resolve('tsx'));
  const esbuild = cmsRequire('esbuild');
  assert.equal(esbuild.version, '0.28.2');
  const transformedTypeScript = esbuild.transformSync('const answer: number = 42', { loader: 'ts' });
  assert.equal(transformedTypeScript.warnings.length, 0);
  assert.match(transformedTypeScript.code, /const answer = 42/u);

  const tsxSmokeDirectory = await mkdtemp(path.join(tmpdir(), 'cms-tsx-smoke-'));
  try {
    const tsxSmokeFile = path.join(tsxSmokeDirectory, 'transpile.ts');
    await writeFile(tsxSmokeFile, 'const answer: number = 42\nif (answer !== 42) process.exitCode = 1\n');
    const tsxSmoke = spawnSync(process.execPath, ['--import', 'tsx', tsxSmokeFile], {
      cwd: fileURLToPath(new URL('cms/', root)),
      env: { PATH: process.env.PATH || process.env.Path || '', NODE_ENV: 'production' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(tsxSmoke.error);
    assert.equal(tsxSmoke.status, 0, 'tsx must transpile and execute TypeScript with the rebuilt esbuild binary');
  } finally {
    await rm(tsxSmokeDirectory, { recursive: true, force: true });
  }

  const payloadCli = fileURLToPath(new URL('cms/node_modules/payload/bin.js', root));
  await access(payloadCli);
  const payloadInfo = spawnSync(process.execPath, [payloadCli, 'info'], {
    cwd: fileURLToPath(new URL('cms/', root)),
    env: {
      PATH: process.env.PATH || process.env.Path || '',
      HOME: process.env.HOME || process.env.USERPROFILE || '/home/node',
      NODE_ENV: 'production',
      CMS_DATABASE_URL: 'postgresql://cms-cli-smoke:unused@127.0.0.1:1/cms_cli_smoke',
      PAYLOAD_SECRET: 'payload-cli-smoke-secret-not-a-real-secret-0001',
      PORTAL_PUBLIC_URL: 'https://portal-cli-smoke.invalid',
      PORTAL_INTERNAL_URL: 'http://portal-internal-cli-smoke.invalid',
      PAYLOAD_TO_PORTAL_SECRET: 'payload-to-portal-cli-smoke-secret-not-a-real-secret-0001',
      PORTAL_TO_PAYLOAD_SECRET: 'portal-to-payload-cli-smoke-secret-not-a-real-secret-0002',
      CMS_UPLOAD_DIR: '/tmp/cms-cli-smoke',
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ifError(payloadInfo.error);
  assert.equal(payloadInfo.status, 0, 'Payload CLI info must run with synthetic settings and no database');
  assert.match(payloadInfo.stdout, /payload:\s+3\.90\.2/u);
  const producer = await import(new URL('scripts/owner-news-payload/bundle.mjs', root));
  const exporter = await import(new URL('scripts/owner-news-payload/export.mjs', root));
  const cutover = await import(new URL('scripts/owner-news-payload/cutover.mjs', root));
  const consumer = await import(new URL('cms/src/migration/bundle.ts', root));
  const legacy = await import(new URL('scripts/import-owner-news.mjs', root));
  for (const fn of [producer.loadBundle, producer.validateBundle, producer.validateRevisionFile,
    exporter.exportNewsBundle, cutover.parseCutoverArguments, consumer.validateImportBundleParts]) assert.equal(typeof fn, 'function');
  // Exercises the API-anchored sharp require used by the actual legacy validator.
  await legacy.validateMedia({ buffer: png, mime: 'image/png' }, 'image');
  assert.equal(producer.snapshotHash({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.equal(path.basename(fileURLToPath(new URL('cms/', root))), 'cms');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkRuntimePackaging().then(() => console.log('CMS packaging closure verified (no services)')).catch(() => {
    console.error('CMS packaging closure failed; inspect allowlisted modules and locked dependencies'); process.exitCode = 1;
  });
}
