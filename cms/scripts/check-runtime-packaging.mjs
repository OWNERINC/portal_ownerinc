import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
