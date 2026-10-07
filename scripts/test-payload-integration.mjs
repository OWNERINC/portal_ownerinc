#!/usr/bin/env node
import { checkIntegrationDirectories, IntegrationGuardError, readIntegrationConfig } from '../cms/tests/support/integration-config.mjs';

try {
  const config = readIntegrationConfig(process.env);
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check-config')) {
    throw new IntegrationGuardError('unsupported_argument');
  }
  await checkIntegrationDirectories(config);
  if (process.argv[2] === '--check-config') {
    console.log('payload-integration: CONFIG_VALID; services not contacted; acceptance NOT_EXECUTED');
  } else {
    // Fail closed until the real HTTP/Firebase fixtures and runtime contracts are
    // integrated. A valid guard or an empty suite must never produce acceptance PASS.
    console.error('payload-integration: acceptance_suite_not_implemented; preparation must be separate; NOT_EXECUTED');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`payload-integration: ${error instanceof IntegrationGuardError ? error.code : 'preflight_failed'}`);
  process.exitCode = 1;
}
