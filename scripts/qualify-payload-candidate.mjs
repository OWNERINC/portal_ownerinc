import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyCandidate, reject } from './lib/payload-candidate-qualification.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 6 || args[0] !== '--candidate' || args[2] !== '--report' || args[4] !== '--output' ||
      args.some((value, index) => index % 2 === 1 && (!value || value.startsWith('--')))) reject('invalid_qualification_arguments');
  for (const file of [args[1], args[3]]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) reject('unsafe_qualification_input');
  }
  const qualified = qualifyCandidate({
    candidateBytes: await readFile(args[1]), reportBytes: await readFile(args[3]),
    expectedRun: { commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT },
    expectedImages: { api: env.API_IMAGE, cron: env.CRON_IMAGE, cms: env.CMS_IMAGE },
  });
  await writeFile(args[5], `${JSON.stringify(qualified, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return qualified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(() => console.log('Recovery-qualified candidate manifest created (not deployment authorization).')).catch(() => {
    console.error('Candidate qualification failed closed; check versioned evidence and bindings.'); process.exitCode = 1;
  });
}
