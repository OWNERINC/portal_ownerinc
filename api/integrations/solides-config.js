const STAGES = Object.freeze({ off: 0, internal: 1, pilot: 2, general: 3, manager: 4, write: 5 });

function parsePilotUids(value = '') {
  return new Set(value.split(',').map((uid) => uid.trim()).filter(Boolean));
}

function readSolidesConfig(env = process.env) {
  const stage = env.SOLIDES_RELEASE_STAGE || 'off';
  return {
    stage,
    stageRank: STAGES[stage],
    token: env.SOLIDES_TOKEN || '',
    employerBaseUrl: env.SOLIDES_EMPLOYER_BASE_URL || '',
    punchBaseUrl: env.SOLIDES_PUNCH_BASE_URL || '',
    reportBaseUrl: env.SOLIDES_REPORT_BASE_URL || '',
    timeoutMs: Number(env.SOLIDES_REQUEST_TIMEOUT_MS || 12000),
    pilotUids: parsePilotUids(env.SOLIDES_PILOT_UIDS),
  };
}

function validateSolidesEnvironment(env = process.env) {
  const config = readSolidesConfig(env);
  if (!Object.hasOwn(STAGES, config.stage)) throw new Error('Invalid environment variable: SOLIDES_RELEASE_STAGE');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60000) {
    throw new Error('Invalid environment variable: SOLIDES_REQUEST_TIMEOUT_MS');
  }
  if (config.stage === 'off') return config;

  for (const [name, value] of [
    ['SOLIDES_TOKEN', config.token],
    ['SOLIDES_EMPLOYER_BASE_URL', config.employerBaseUrl],
    ['SOLIDES_PUNCH_BASE_URL', config.punchBaseUrl],
  ]) if (!value) throw new Error(`Missing required environment variable: ${name}`);

  for (const [name, value] of [
    ['SOLIDES_EMPLOYER_BASE_URL', config.employerBaseUrl],
    ['SOLIDES_PUNCH_BASE_URL', config.punchBaseUrl],
    ['SOLIDES_REPORT_BASE_URL', config.reportBaseUrl],
  ]) {
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error(`Invalid environment variable: ${name}`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid environment variable: ${name}`);
    }
  }
  return config;
}

function hasEmployeeAccess(user, config = readSolidesConfig()) {
  if (!user || user.contract_type === 'pj' || user.is_pj) return false;
  if (config.stageRank >= STAGES.general) return true;
  if (config.stage === 'pilot') return config.pilotUids.has(user.uid);
  return false;
}

module.exports = {
  STAGES, hasEmployeeAccess, parsePilotUids, readSolidesConfig, validateSolidesEnvironment,
};
