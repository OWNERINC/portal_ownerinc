// Synthetic, read-only browser fixtures for scripts/test-route-recovery-browser.mjs.
// This deliberately models one Firebase identity and two API-confirmed Portal
// roles without contacting Firebase, an API service, a database, or production.
import { createHash } from 'node:crypto';

export const SYNTHETIC_UID = 'route-recovery-synthetic-user';
export const SYNTHETIC_TOKEN = `route-recovery-token-${SYNTHETIC_UID}`;
export const PREVIEW_ID = '11111111-1111-4111-8111-111111111111';
export const PREVIEW_VERSION = '22222222-2222-4222-8222-222222222222';
export const REMINDER_ID = '33333333-3333-4333-8333-333333333333';

const firebaseOrigin = 'https://www.gstatic.com';
const firebaseVersion = '/firebasejs/10.12.0/';
const expectedBlockedExternalResources = new Map([
  ['https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=600&q=80', 'dashboard-editorial-fallback'],
  ['https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80', 'dashboard-editorial-fallback'],
  ['https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=600&q=80', 'dashboard-editorial-fallback'],
]);

export function parseLoopbackBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Base URL must be an absolute HTTP loopback URL, for example http://127.0.0.1:8080.'); }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Base URL must be an HTTP loopback origin only; production and non-loopback hosts are forbidden.');
  }
  return url.origin;
}

// Refuse all encoded or non-canonical path spellings before API classification.
// The app's current public/API routes use ASCII paths with no encoded segments;
// query strings are checked separately and are not passed to this function.
export function classifyRouteRecoveryPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('%')
    || pathname.includes('\\') || pathname.includes('//') || pathname.includes('\0')
    || pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    return { kind: 'unsafe-path', pathname, reason: 'encoded-or-noncanonical-path' };
  }
  return {
    kind: pathname === '/api' || pathname.startsWith('/api/') ? 'api' : 'static',
    pathname,
  };
}

export function compareStaticResponseBytes(localBytes, responseBytes) {
  const local = Buffer.from(localBytes);
  const response = Buffer.from(responseBytes);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  return {
    matches: local.equals(response),
    localBytes: local.byteLength,
    responseBytes: response.byteLength,
    localSha256: sha256(local),
    responseSha256: sha256(response),
  };
}

// Bound browser shutdown, but retain the test failure as primary if cleanup
// also fails. A cleanup-only rejection/timeout still fails the run.
export async function runWithBoundedBrowserClose(browser, run, timeoutMs = 5_000) {
  let value;
  let primaryError;
  try { value = await run(); }
  catch (error) { primaryError = error; }

  let timer;
  const closeResult = Promise.resolve().then(() => browser.close()).then(
    () => ({ ok: true }),
    error => ({ ok: false, error }),
  );
  const timeoutResult = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false, error: new Error(`browser.close exceeded ${timeoutMs}ms cleanup limit`) }), timeoutMs);
  });
  const cleanup = await Promise.race([closeResult, timeoutResult]);
  clearTimeout(timer);
  const cleanupError = cleanup.ok ? null : cleanup.error;

  if (primaryError) {
    if (cleanupError && primaryError && typeof primaryError === 'object') {
      try { Object.defineProperty(primaryError, 'cleanupError', { value: cleanupError, configurable: true }); }
      catch { /* Keep the original failure even if an exotic Error is immutable. */ }
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return value;
}

export function syntheticUser(role = 'admin') {
  if (!['admin', 'viewer'].includes(role)) throw new Error(`Unsupported synthetic role: ${role}`);
  return role === 'admin'
    ? {
      uid: SYNTHETIC_UID, role, name: 'Synthetic Route Recovery Admin',
      email: 'route-recovery-admin@example.test', permissions: { superAdmin: true },
      autocard_access: false, pos_cards_access: false,
    }
    : {
      uid: SYNTHETIC_UID, role, name: 'Synthetic Route Recovery Viewer',
      email: 'route-recovery-viewer@example.test', permissions: {},
      autocard_access: false, pos_cards_access: false,
    };
}

const article = Object.freeze({
  id: 'route-recovery-news-article',
  title: 'Synthetic Owner News Article',
  category: 'Synthetic QA',
  published_at: '2026-10-01T12:00:00.000Z',
  content_version: 1,
  content_blocks: [{ type: 'paragraph', text: 'Synthetic Owner News body for route-recovery acceptance.' }],
});

const fixtures = Object.freeze({
  knowledge: Object.freeze({
    id: 'route-recovery-knowledge-article', title: 'Synthetic Knowledge Fixture',
    category: 'Synthetic QA', updated_at: '2026-10-01T12:00:00.000Z',
    content_blocks: [{ type: 'paragraph', text: 'Synthetic Knowledge body for route-recovery acceptance.' }],
  }),
  reminder: Object.freeze({
    id: REMINDER_ID, title: 'Synthetic Reminder Fixture', description: 'Synthetic reminder body.',
    content_blocks: [{ type: 'paragraph', text: 'Synthetic reminder content.' }],
    trigger_day: 15, target_users: 'all', channel: 'email', active: true,
    next_occurrence: '2026-10-15', created_at: '2026-10-01T12:00:00.000Z',
  }),
  course: Object.freeze({
    id: 'route-recovery-academy-course', title: 'Synthetic Academy Course',
    category: 'Synthetic QA', description: 'Synthetic Academy course body.',
    active: true, delivery_mode: 'internal', content_blocks: [], modules: [],
  }),
  benefit: Object.freeze({
    id: 'route-recovery-benefit', company: 'Synthetic Benefits Partner',
    category: 'Synthetic QA', description: 'Synthetic benefits description.',
    instructions: 'Use the synthetic fixture only.', active: true,
    content_blocks: [{ type: 'paragraph', text: 'Synthetic benefit body.' }],
  }),
  cmsDocument: Object.freeze({
    id: 'route-recovery-cms-document', content_type: 'knowledge',
    title: 'Synthetic CMS Document Fixture', category: 'Synthetic QA',
    updated_at: '2026-10-01T12:00:00.000Z', status: 'published',
  }),
  adminUser: Object.freeze({
    uid: 'route-recovery-readonly-user', name: 'Synthetic Admin List Fixture',
    email: 'route-recovery-list@example.test', role: 'viewer', contract_type: 'clt',
    job_title: 'Synthetic QA', state: 'active', permissions: {},
  }),
  previewArticle: Object.freeze({
    id: PREVIEW_ID, title: 'Synthetic Saved Preview Fixture', category: 'Synthetic QA',
    content_version: 2, asset_scope: 'owner-news-preview',
    preview_revision: { id: PREVIEW_VERSION, source: 'payload', status: 'draft' },
    content_blocks: [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
      { type: 'text', text: 'Synthetic saved preview body.', marks: [] },
    ] }] }],
  }),
});

function fixtureResult(body, total = null) {
  return { kind: 'fixture', status: 200, body, ...(total === null ? {} : { total }) };
}

export function resolveRouteRecoveryAPI({ url, method = 'GET', role = 'admin', solidesLinked = true }) {
  const requestUrl = url instanceof URL ? url : new URL(url);
  const normalizedMethod = String(method).toUpperCase();
  if (!['GET', 'HEAD'].includes(normalizedMethod)) {
    return { kind: 'denied-write', status: 405, body: { error: 'route_recovery_read_only' } };
  }
  const path = classifyRouteRecoveryPath(requestUrl.pathname);
  if (path.kind === 'unsafe-path') return { kind: 'unsafe-path', status: 400, body: { error: path.reason } };
  if (path.kind !== 'api') {
    return { kind: 'not-api', status: 0, body: null };
  }
  if (!['admin', 'viewer'].includes(role)) {
    return { kind: 'unknown-api', status: 500, body: { error: 'unsupported_synthetic_role' } };
  }

  const { pathname, searchParams } = requestUrl;
  if (pathname === '/api/users/me') return fixtureResult(syntheticUser(role));
  if (pathname === '/api/knowledge' && !searchParams.has('all')) return fixtureResult([fixtures.knowledge], 1);
  if (pathname === '/api/knowledge/categories') return fixtureResult(['Synthetic QA']);
  if (pathname === '/api/reminders/upcoming') return fixtureResult([fixtures.reminder]);
  if (pathname === '/api/reminders' && searchParams.get('all') === 'true') return fixtureResult([fixtures.reminder], 1);
  if (pathname === '/api/reminders/deliveries') return fixtureResult([{
    reminder_id: REMINDER_ID, reminder_title: fixtures.reminder.title,
    recipient_name: 'Synthetic Recipient', recipient_email: 'route-recovery-recipient@example.test',
    scheduled_date: '2026-10-15', status: 'sent', channel: 'email', attempt_count: 1,
  }], 1);
  if (pathname === '/api/reminders/cron-status') return fixtureResult(null);
  if (pathname === '/api/academy/continue') return fixtureResult([]);
  if (pathname === '/api/academy/categories') return fixtureResult(['Synthetic QA']);
  if (pathname === '/api/academy' && searchParams.has('group')) {
    return fixtureResult([fixtures.course], 1);
  }
  if (pathname === '/api/academy' && searchParams.get('active') === 'true') return fixtureResult([fixtures.course], 1);
  if (pathname === '/api/announcements/home') return fixtureResult({ content: null });
  if (pathname === '/api/announcements/categories') return fixtureResult({ total: 1, categories: [{ name: 'Synthetic QA', count: 1 }] });
  if (pathname === '/api/announcements/polls/current') return fixtureResult({ poll: null });
  if (pathname === '/api/announcements' && searchParams.get('kind') === 'article') {
    return fixtureResult([article], 1);
  }
  if (pathname === `/api/announcements/preview/${PREVIEW_ID}`
    && searchParams.get('version') === PREVIEW_VERSION && searchParams.get('source') === 'payload') {
    return fixtureResult(fixtures.previewArticle);
  }
  if (pathname === '/api/benefits' && searchParams.get('active') === 'true') return fixtureResult([fixtures.benefit], 1);
  if (pathname === '/api/benefits/categories') return fixtureResult(['Synthetic QA']);
  if (pathname === '/api/cms/documents' && searchParams.get('type') === 'knowledge') {
    return fixtureResult([fixtures.cmsDocument], 1);
  }
  if (pathname === '/api/cms/documents' && searchParams.has('type')) return fixtureResult([], 0);
  if (pathname === '/api/cms/session/availability') {
    return fixtureResult({ mode: 'legacy', epoch: 1, activated: false, runtimeReady: false, canEnter: false });
  }
  if (pathname === '/api/users' || pathname === '/api/users/audit' || pathname === '/api/job-titles') {
    const data = pathname === '/api/users' ? [fixtures.adminUser]
      : pathname === '/api/users/audit' ? [{
        id: 'route-recovery-audit-row', action: 'user.list', created_at: '2026-10-01T12:00:00.000Z',
        actor_name: 'Synthetic Admin', target_type: 'user', target_id: 'route-recovery-readonly-user', request_id: 'route-recovery-audit',
      }]
        : [{ id: 'route-recovery-job-title', name: 'Synthetic QA', active: true, user_count: 1 }];
    return fixtureResult(data, 1);
  }
  if (pathname === '/api/solides/admin/status') return fixtureResult({ enabled: false, stage: 'disabled' });
  if (pathname === '/api/solides/me/status') return fixtureResult({ linked: solidesLinked });
  if (pathname === '/api/solides/me/summary') return fixtureResult({
    entries: [{ startAt: '2026-10-07T08:00:00.000Z', endAt: '2026-10-07T17:00:00.000Z' }],
    dataAsOf: '2026-10-07T17:05:00.000Z',
  });
  if (pathname === '/api/solides/me/hours-balance') return fixtureResult({ hoursBalanceInMinutes: 60 });
  if (pathname === '/api/solides/me/schedule') return fixtureResult({
    employee: { schedule: { name: 'Synthetic Schedule', days: [{ day: 1, shifts: [{ start: '09:00', end: '18:00' }] }] } },
  });
  if (pathname === '/api/solides/me/adjustments') return fixtureResult({ entries: [] });
  if (pathname === '/api/solides/me/punches') return fixtureResult({
    source: 'solides', dataAsOf: '2026-10-07T17:05:00.000Z', entries: [{
      date: '2026-10-07T00:00:00.000Z', dateIn: '2026-10-07T08:00:00.000Z',
      dateOut: '2026-10-07T17:00:00.000Z', status: 'Synthetic fixture',
    }],
  }, 1);

  return { kind: 'unknown-api', status: 404, body: { error: 'route_recovery_fixture_missing', path: pathname } };
}

export function firebaseStubSource(url) {
  const parsed = url instanceof URL ? url : new URL(url);
  if (parsed.origin !== firebaseOrigin || !parsed.pathname.startsWith(firebaseVersion)) return null;
  if (parsed.pathname === `${firebaseVersion}firebase-app.js`) {
    return `export function initializeApp(options) { return { options, name: '[DEFAULT]' }; }\n`;
  }
  if (parsed.pathname === `${firebaseVersion}firebase-auth.js`) {
    return `
export const browserLocalPersistence = Object.freeze({ synthetic: true });
export function initializeAuth(app) {
  const uid = 'route-recovery-synthetic-user';
  const currentUser = Object.freeze({ uid, async getIdToken() { return 'route-recovery-token-route-recovery-synthetic-user'; } });
  return { app, currentUser, async authStateReady() {} };
}
export function connectAuthEmulator() {}
export function onAuthStateChanged(auth, callback) { queueMicrotask(() => callback(auth.currentUser)); return () => {}; }
export async function signOut(auth) { auth.currentUser = null; }
export async function updateProfile() {}
`;
  }
  return null;
}

export function isAllowlistedFirebaseModule(url) {
  return firebaseStubSource(url) !== null;
}

// The dashboard intentionally references these fixed public fallback photos.
// They remain blocked from the network during this offline acceptance run;
// only these exact URLs count as expected denials, never as allowed requests.
export function expectedBlockedExternalResource(url) {
  const parsed = url instanceof URL ? url : new URL(url);
  return expectedBlockedExternalResources.get(parsed.href) || null;
}
