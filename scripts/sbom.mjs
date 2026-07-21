#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const service of ['api', 'cron']) {
  const directory = await mkdtemp(path.join(tmpdir(), `ownerinc-${service}-`));
  try {
    const manifest = JSON.parse(await readFile(`${service}/package.json`, 'utf8'));
    const lock = JSON.parse(await readFile(`${service}/package-lock.json`, 'utf8'));
    manifest.version = lock.version = lock.packages[''].version = '0.0.0';
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    const sbom = execFileSync(process.execPath, [
      process.env.npm_execpath, 'sbom', '--prefix', directory, '--package-lock-only', '--sbom-format', 'spdx',
    ]);
    await writeFile(`${service}.spdx.json`, sbom);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
