#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const command of ['git', 'node', 'npm']) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`doctor: ${command} not found`);
  console.log(`${command}: ${result.stdout.trim()}`);
}

const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
console.log(docker.status === 0
  ? `docker: ${docker.stdout.trim()}`
  : 'docker: Compose unavailable; required only for the full stack');
console.log(existsSync('.env')
  ? 'environment: .env found'
  : 'environment: create .env from .env.example before starting services');
