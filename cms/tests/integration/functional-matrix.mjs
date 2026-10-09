// Executable acceptance inventory. No heading/config check can complete this matrix.
const requiredChecks = Object.freeze({
  'CMS-01':['real_browser_login_profile_uid_matches','academy_areas_exact','benefits_area_exact','viewer_issuance_denied','viewer_no_native_projection'],
  'CMS-02':['ui_v2_issuance_ack','native_me_session_profile_same_uid','secure_host_only_browser_cookie','legacy_epoch_one'],
  'CMS-05':['origin_denials_no_session_write','real_emulator_session_issued','cookie_attributes_two_hour_lifetime','database_hash_only','distinct_rotation_old_cookie_denied'],
  'CMS-07-legacy-policy':['native_news_denied_or_empty','locks_empty_no_editor_identity','lock_mutation_denied','native_article_create_denied','anonymous_me_user_null_no_store_writes'],
  'AUTH-01':['editorial_ui_delete_confirmed','cookie_removed_old_native_cookie_denied','firebase_portal_session_retained'],
  'AUTH-02-portal':['portal_delete_ack_before_observed_signed_out','firebase_signed_out','revoked_database_row_cookie_denied'],
  'AUTH-expiry-permission':['permission_reloaded_from_real_database','expired_unrevoked_cookie_denied','revoke_confirmed','revoked_unexpired_cookie_denied'],
  'OPS-preauthority-integrity':['news_rows_versions_jobs_unchanged','authority_legacy_epoch_one','independent_fresh_physical_targets','protocol_worker_import_absent'],
});
const preauthority = (scenarioId, profile, preconditions, expected, evidence) => Object.freeze({
  scenarioId, phase: 'preauthority', profile, preconditions, expected, evidence,
  requiredChecks: Object.freeze(requiredChecks[scenarioId]), implemented: true,
});
const remainingContracts = Object.freeze({
  'NEWS-01':['UI login → create new article → save/autosave → saved-version preview → publish → reader → logout','new document ID; real saved Versions ID; independent reader and database'],
  'NEWS-02':['published A stays visible while draft B is private; withdraw denies exclusive article/media','two distinct revision IDs; two reader accounts; before/after publication'],
  'NEWS-03':['conflict/pending/lost ACK preserves baseline and reconciles without duplicate effects','induced real concurrency/fault; independent durable receipt; UI state'],
  'NEWS-04':['Task9 dirty/pending Back/Forward, toolbar and History API follow approved decision contract','fresh attempt/event/decision/result traces; preserve historical FAIL'],
  'NEWS-05':['cross-tab expiry, permission/account revocation hides editor/media; stale signOut does not affect new UID','two real tabs and UIDs; next request denial; no DELETE on cancelled exit'],
  'NEWS-06':['editorial retains Firebase; Portal revokes before signOut; failed DELETE remains retryable','real logout gestures and ordered ACK/SDK events; unavailable dependency proof'],
  'NEWS-07':['reader categories/pages/neighbors/deep links preserve IDs and totals; 503 never falls back','independent reader API/browser; category totals; focus/history/scroll trace'],
  'NEWS-08':['poll publication/vote/close is idempotent for same choice and 409 for conflicting choice','real SQL votes; concurrent clients; loss-of-response reconciliation'],
  'NEWS-09':['scheduled snapshot A publishes once across two workers/restart without losing draft B','saved snapshot hash and IDs; workers/jobs SQL; cancellation invalidates stale work'],
  'NEWS-10':['original image/PDF/video bytes and Range/CSP guards survive publication/withdrawal','real uploaded bytes SHA/MIME; 206/416; rich text script and URL bypass negatives'],
  'NEWS-11':['creation starts with no preexisting article and traverses upload/draft/Versions/publication','UI create gesture; before-empty/after-ID; upload hash; version ID; reader proof'],
  'PUB-01':['only explicit publication changes public revision; save/autosave do not publish','independent public revision ID before/after'],
  'PUB-02':['saved revision preview never uses an unsaved draft or document ID as Versions ID','documentId and versionId separately recorded'],
  'PUB-03':['reader identities cannot observe another draft or preview','authorized/unauthorized reader HTTP bodies reduced to leak booleans'],
  'PUB-04':['withdrawal revokes article and exclusively referenced media without erasing history','reader denial and retained historical references'],
  'PUB-05':['native Versions restore preserves history and public revision until explicit publish','real native restore gesture; version lineage; reader revision'],
  'PUB-06':['scheduled publication uses exact saved snapshot, actor and civil timezone','snapshot hash; clock boundary; actual job effect'],
  'PUB-07':['cancel/reschedule/withdraw fences queued stale jobs','two competing workers and durable cancellation receipt'],
  'PUB-08':['home/global publication has its own draft/public revision boundary','native global Versions and public home DTO'],
  'PUB-09':['list/count/category/order/neighbors describe the same published inventory','reader SQL/API inventory and pagination IDs'],
  'PUB-10':['publication failures/unknown commits reconcile without false success or fallback','real fault boundary; durable receipt; retained failed run'],
  'CMS-03':['zero-record creation is distinguished from opening an existing source_id','UI create action and independent domain/document IDs'],
  'CMS-04':['upload originals remain private, bounded, immutable and reference-safe','real file upload signature/bytes and private download authorization'],
  'CMS-06':['generic v2 capability alone does not grant native News write authority','real current grants, authority and negative native mutation'],
  'SEC-01':['invalid/disabled/unverified identity never becomes an editor','real emulator/account state and no new projection'],
  'SEC-02':['Origin/CSP/private path and native API bypass attempts fail closed','actual headers and negative requests; no authority alteration'],
  'SEC-03':['malformed signature/MIME/oversize/unsafe rich text is rejected','real upload failures and script execution/leak observations'],
  'SEC-04':['retention protects shared draft/version/snapshot references and refuses physical article DELETE','owned synthetic assets; real reference stores; history-retention denial'],
  'UX-01':['dirty/pending cancellation, responsive navigation and retry match approved UX','real browser gestures and event lifecycle; not heading-only'],
  'AUTH-02-delete-failure':['failed session DELETE cannot claim logout success or signOut the wrong UID','real dependency outage and successful explicit retry'],
  'AUTH-cross-tab-bfcache':['revocation/account change and browser history do not resurrect stale editor state','real tabs/history lifecycle and next request denial'],
  'OPS-01':['owned service restart preserves IDs, media and Versions','new process IDs; equal persistent inventory and original byte hashes'],
  'OPS-02':['authorized isolated restore preserves all four stores and release compatibility','positive Linux recovery lease and independent restored inventory'],
  'OPS-03':['physical target, storage and manifest mismatch fails before writes','new negative lease; no DB/storage mutation'],
  'OPS-04':['cleanup is restricted to owned unreferenced unpublished synthetic data','owned-ID manifest; retained historical references; human authorization'],
  'HUB-other-areas':['Knowledge/Academy/Benefits/Reminders retain their documented boundaries','separate area capabilities; real domain source IDs and scoped read/write evidence'],
});
const deferred = (scenarioId, dependency) => Object.freeze({ scenarioId, phase: 'remaining',
  profile: 'declared-in-acceptance-plan', preconditions: [dependency],
  expected: [remainingContracts[scenarioId][0]],
  evidence: [remainingContracts[scenarioId][1]], implemented: false, dependency });

export const functionalCases = Object.freeze([
  preauthority('CMS-01', 'academy-admin,benefits-admin,viewer', ['fresh Portal/CMS databases', 'real verified emulator accounts'],
    ['hub areas exactly follow current grants', 'viewer API session issuance denied'], ['browser controls', 'HTTP status', 'current profile']),
  preauthority('CMS-02', 'academy-admin', ['legacy/1', 'real CMS readiness', 'HTTPS browser login'],
    ['native admin reached through hub after real v2 issuance', 'same UID in Portal/session/native me', 'no News mutation'], ['cookie attributes', 'HTTP bodies reduced to booleans', 'database inventories']),
  preauthority('CMS-05', 'benefits-admin', ['HTTPS', 'real API/PostgreSQL/Firebase Emulator'],
    ['two-hour secure host-only cookie', 'only SHA256 persisted', 'replacement revokes old cookie', 'Origin denied before issuance'], ['HTTP statuses', 'SQL assertions', 'cookie attribute booleans']),
  preauthority('CMS-07-legacy-policy', 'academy-admin,viewer,anonymous', ['legacy/1', 'native REST'],
    ['News reads/writes denied', 'locks empty and identity-free', 'native access map denies News and Versions'], ['native REST statuses', 'before/after News digest']),
  preauthority('AUTH-01', 'academy-admin', ['native session issued through browser'],
    ['real editorial logout revokes cookie', 'replay denied', 'Firebase Portal identity retained'], ['DELETE 204', 'GET 401', 'UID equality boolean']),
  preauthority('AUTH-02-portal', 'academy-admin', ['new browser editorial session'],
    ['Portal logout confirms editorial revocation before Firebase signOut', 'both client identity and cookie removed'], ['ordered request/response events', 'SQL revoked row', 'browser signed-out state']),
  preauthority('AUTH-expiry-permission', 'benefits-admin', ['only owned synthetic profile/session rows are changed'],
    ['current grants reloaded', 'expired unrevoked session denied', 'revoked unexpired session denied'], ['SQL flags', 'GET statuses']),
  preauthority('OPS-preauthority-integrity', 'fixture-owner', ['all previous preauthority cases finished'],
    ['legacy/1 unchanged', 'News store digest unchanged', 'no worker/import/protocol activity'], ['physical cluster bindings', 'News row digests', 'authority before/after']),
  ...['NEWS-01','NEWS-02','NEWS-03','NEWS-04','NEWS-05','NEWS-06','NEWS-07','NEWS-08','NEWS-09','NEWS-10','NEWS-11',
    'PUB-01','PUB-02','PUB-03','PUB-04','PUB-05','PUB-06','PUB-07','PUB-08','PUB-09','PUB-10'].map(id => deferred(id, 'gate4_verified_native_writer_and_durable_authority_admission')),
  ...['CMS-03','CMS-04','CMS-06','SEC-01','SEC-02','SEC-03','SEC-04','UX-01','AUTH-02-delete-failure',
    'AUTH-cross-tab-bfcache','OPS-01','OPS-02','OPS-03','OPS-04','HUB-other-areas'].map(id => deferred(id, 'dedicated_remaining_integrated_suite')),
]);

export function newFunctionalReport(runId) {
  return { schemaVersion: 1, runId, scope: 'preauthority-real-https-first-slice',
    status: 'INCOMPLETE', acceptanceComplete: false, productionValidated: false,
    layers: { portalApi: 'NOT_EXECUTED', firebase: 'NOT_EXECUTED', cms: 'NOT_EXECUTED', nginx: 'NOT_EXECUTED', browser: 'NOT_EXECUTED' },
    cases: functionalCases.map(item => ({ ...item, status: 'INCOMPLETE', reason: item.implemented ? 'not_executed' : item.dependency,
      observations: [], startedAt: null, finishedAt: null })), cleanup: 'not_started' };
}

export function finishFunctionalReport(report) {
  if (!Array.isArray(report.cases) || report.cases.length !== functionalCases.length ||
    report.cases.some((item,index) => item.scenarioId !== functionalCases[index].scenarioId ||
      item.phase !== functionalCases[index].phase || item.implemented !== functionalCases[index].implemented ||
      !['PASS','FAIL','INCOMPLETE'].includes(item.status) ||
      item.status === 'PASS' && (!functionalCases[index].implemented ||
        (item.observations || []).some(value=>value.passed!==true ||
          Object.keys(value).some(key=>!['check','passed','httpStatus'].includes(key))) ||
        JSON.stringify((item.observations || []).map(value=>value.check).sort()) !== JSON.stringify([...functionalCases[index].requiredChecks].sort())))) {
    report.status='FAIL';report.acceptanceComplete=false;report.preauthorityComplete=false;
    report.failure={stage:'report_inventory',reason:'functional_report_contract_invalid'};return 1;
  }
  report.acceptanceComplete = report.cases.every(item => item.implemented && item.status === 'PASS');
  report.status = report.cases.some(item => item.status === 'FAIL') ? 'FAIL' : report.acceptanceComplete ? 'PASS' : 'INCOMPLETE';
  report.preauthorityComplete = report.cases.filter(item => item.phase === 'preauthority').every(item => item.status === 'PASS');
  return report.status === 'FAIL' ? 1 : report.status === 'PASS' ? 0 : 2;
}

export async function runFunctionalCase(report, id, operation) {
  const item = report.cases.find(candidate => candidate.scenarioId === id);
  if (!item || !item.implemented || item.status !== 'INCOMPLETE') throw new Error('functional_case_contract_invalid');
  item.startedAt = new Date().toISOString();
  try {
    const observations = await operation();
    if (!Array.isArray(observations) || observations.length === 0 ||
      JSON.stringify(observations.map(value=>value?.check).sort()) !== JSON.stringify([...functionalCases.find(value=>value.scenarioId===id).requiredChecks].sort()) || observations.some(value =>
      !value || typeof value.check !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value.check) || value.passed !== true ||
      Object.keys(value).some(key => !['check', 'passed', 'httpStatus'].includes(key)) ||
      value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))) {
      throw new Error('functional_evidence_contract_invalid');
    }
    item.observations = observations;
    item.status = 'PASS'; item.reason = null;
  } catch {
    item.status = 'FAIL'; item.reason = 'acceptance_assertion_failed';
    throw new Error('functional_case_failed');
  } finally { item.finishedAt = new Date().toISOString(); }
}
