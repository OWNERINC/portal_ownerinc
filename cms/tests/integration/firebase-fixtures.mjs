#!/usr/bin/env node
// Explicitly opt-in, Auth-Emulator-only fixture check. No Portal/CMS DB or API.
import { createRequire } from 'node:module';
import {
  createFirebaseIdentityFixtures,
  FirebaseFixtureError,
  readFirebaseFixtureConfig,
} from '../support/firebase-auth-fixtures.mjs';

const EXPECTED_PROJECT = 'demo-ownerinc-payload-local';
const EXPECTED_ORIGIN = 'http://127.0.0.1:9299';
const EXPECTED_EMULATOR_HOST = '127.0.0.1:9299';

function parseArgs(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--run') {
      if (options.run) throw new Error('duplicate_opt_in');
      options.run = true;
      continue;
    }
    if (!['--project', '--emulator', '--run-id'].includes(key) || options[key]) throw new Error('unsupported_argument');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('argument_value_required');
    options[key] = value;
  }
  return options;
}

function safeCode(error) {
  return error instanceof FirebaseFixtureError ? error.code : 'fixture_check_failed';
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(`firebase-fixtures: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (!options.run) {
    console.error('firebase-fixtures: explicit --run opt-in required');
    process.exitCode = 2;
    return;
  }
  if (options['--project'] !== EXPECTED_PROJECT || options['--emulator'] !== EXPECTED_ORIGIN
      || !options['--run-id']) {
    console.error('firebase-fixtures: exact demo project, loopback emulator and fresh run UUID required');
    process.exitCode = 2;
    return;
  }

  const existingEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (existingEmulatorHost && existingEmulatorHost !== EXPECTED_EMULATOR_HOST) {
    console.error('firebase-fixtures: conflicting emulator environment refused');
    process.exitCode = 2;
    return;
  }
  const existingProject = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (existingProject && existingProject !== EXPECTED_PROJECT) {
    console.error('firebase-fixtures: conflicting project environment refused');
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = readFirebaseFixtureConfig({
      PAYLOAD_TEST_FIREBASE_PROJECT_ID: options['--project'],
      PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL: options['--emulator'],
    }, { runId: options['--run-id'] });
  } catch (error) {
    console.error(`firebase-fixtures: ${safeCode(error)}`);
    process.exitCode = 2;
    return;
  }

  let fixtureSet;
  let cleanupRetry;
  let adminApp;
  let deleteAdminApp;
  let primaryFailure = false;
  try {
    const configResponse = await fetch(`${config.origin}/emulator/v1/projects/${config.projectId}/config`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!configResponse.ok) throw new FirebaseFixtureError('emulator_config_unavailable');
    await configResponse.json();
    console.log(`PASS emulator_config project=${config.projectId}`);

    process.env.FIREBASE_AUTH_EMULATOR_HOST = EXPECTED_EMULATOR_HOST;
    process.env.GCLOUD_PROJECT = EXPECTED_PROJECT;
    const fromAPI = createRequire(new URL('../../../api/package.json', import.meta.url));
    const { initializeApp, deleteApp } = fromAPI('firebase-admin/app');
    deleteAdminApp = deleteApp;
    const { getAuth } = fromAPI('firebase-admin/auth');
    adminApp = initializeApp({ projectId: config.projectId }, `task15-${config.runId}`);
    const adminAuth = getAuth(adminApp);

    fixtureSet = await createFirebaseIdentityFixtures(config, { adminAuth });
    const identities = Object.values(fixtureSet.identities);
    for (const fixture of identities) {
      const persisted = await adminAuth.getUser(fixture.uid);
      if (persisted.uid !== fixture.uid || persisted.email !== fixture.email
          || persisted.emailVerified !== fixture.emailVerified) {
        throw new FirebaseFixtureError('emulator_admin_identity_mismatch');
      }
      console.log(`PASS identity role=${fixture.role} project=${config.projectId} email_verified=${fixture.emailVerified}`);
    }
    console.log(`PASS fixture_setup count=${identities.length} project=${config.projectId}`);
  } catch (error) {
    primaryFailure = true;
    if (typeof error?.retryCleanup === 'function') cleanupRetry = error.retryCleanup;
    else if (error?.cleanupComplete === true) console.log('PASS cleanup scope=created_fixture_uids');
    console.error(`FAIL fixture_setup code=${safeCode(error)}`);
  } finally {
    if (fixtureSet) cleanupRetry = fixtureSet.cleanup;
    if (cleanupRetry) {
      let cleaned = false;
      for (let attempt = 1; attempt <= 3 && !cleaned; attempt++) {
        try {
          await cleanupRetry();
          cleaned = true;
          console.log('PASS cleanup scope=created_fixture_uids');
        } catch (error) {
          const pending = Number.isInteger(error?.pendingCleanupCount) ? error.pendingCleanupCount : 'unknown';
          console.error(`CLEANUP_RETRY attempt=${attempt} pending=${pending} code=exact_uid_delete_incomplete`);
          if (typeof error?.retryCleanup === 'function') cleanupRetry = error.retryCleanup;
        }
      }
      if (!cleaned) {
        primaryFailure = true;
        console.error('FAIL cleanup incomplete; retained only run-scoped UID retry handles in process memory');
      }
    } else if (fixtureSet) {
      primaryFailure = true;
      console.error('FAIL cleanup handle unavailable');
    }
    if (adminApp) {
      try {
        await deleteAdminApp(adminApp);
      } catch {
        primaryFailure = true;
        console.error('FAIL admin_app_close');
      }
    }
  }
  if (primaryFailure) process.exitCode = 1;
}

main().catch(() => {
  console.error('firebase-fixtures: unexpected sanitized runner failure');
  process.exitCode = 1;
});
