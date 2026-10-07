#!/usr/bin/env node
// Opt-in browser acceptance against an already-running, isolated Linux Nginx.
// This runner never starts services, sends writes, or targets non-loopback URLs.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PREVIEW_ID,
  PREVIEW_VERSION,
  SYNTHETIC_TOKEN,
  classifyRouteRecoveryPath,
  compareStaticResponseBytes,
  expectedBlockedExternalResource,
  firebaseStubSource,
  parseLoopbackBaseUrl,
  resolveRouteRecoveryAPI,
  runWithBoundedBrowserClose,
} from '../tests/fixtures/route-recovery-browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 20_000;
const JS_MIME = /^(application|text)\/(javascript|ecmascript)\b/i;

function usage() {
  return [
    'Usage: node scripts/test-route-recovery-browser.mjs --base-url http://127.0.0.1:8080 --playwright-module <absolute-path-to-playwright/index.mjs>',
    '',
    'Required: --base-url (HTTP loopback Nginx origin) and --playwright-module, or PLAYWRIGHT_MODULE.',
    'Optional: --timeout-ms <positive integer>. This command does not launch Nginx, Docker, or a browser server.',
    'All API calls are synthetic in-memory GET/HEAD fixtures. Every API write, unknown API, and non-allowlisted external request is denied and fails the run.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { baseUrl: null, playwrightModule: process.env.PLAYWRIGHT_MODULE || null, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.\n${usage()}`);
    if (flag === '--base-url') args.baseUrl = value;
    else if (flag === '--playwright-module') args.playwrightModule = value;
    else if (flag === '--timeout-ms') args.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${flag}.\n${usage()}`);
    index += 1;
  }
  if (!args.baseUrl) throw new Error(`--base-url is required.\n${usage()}`);
  if (!args.playwrightModule) throw new Error(`--playwright-module or PLAYWRIGHT_MODULE is required.\n${usage()}`);
  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1_000) throw new Error('--timeout-ms must be an integer of at least 1000.');
  args.baseOrigin = parseLoopbackBaseUrl(args.baseUrl);
  return args;
}

async function loadPlaywright(specifier) {
  const absolute = path.resolve(specifier);
  const resolved = (await stat(absolute)).isDirectory() ? path.join(absolute, 'index.mjs') : absolute;
  const playwright = await import(pathToFileURL(resolved).href);
  if (!playwright.chromium?.launch) throw new Error(`Playwright module has no chromium.launch export: ${resolved}`);
  return playwright;
}

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function staticResourceType(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.html') return { label: 'HTML', mime: /^text\/html\b/i };
  if (extension === '.css') return { label: 'CSS', mime: /^text\/css\b/i };
  if (extension === '.js' || extension === '.mjs') return { label: 'JavaScript', mime: JS_MIME };
  return null;
}

async function fetchStatic(baseOrigin, route, method = 'GET') {
  return fetch(new URL(route, baseOrigin), { method, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
}

async function sweepNginxStatic(baseOrigin) {
  const files = await walkFiles(path.join(ROOT, 'public'));
  const resources = files.map(file => ({
    file,
    route: `/${path.relative(path.join(ROOT, 'public'), file).split(path.sep).join('/')}`,
    type: staticResourceType(file),
  })).filter(resource => resource.type);
  const counts = { HTML: 0, JavaScript: 0, CSS: 0 };
  for (const resource of resources) {
    counts[resource.type.label] += 1;
    const response = await fetchStatic(baseOrigin, resource.route);
    assert.equal(response.status, 200, `${resource.route} must be served directly by the supplied Nginx origin`);
    assert.match(response.headers.get('content-type') || '', resource.type.mime,
      `${resource.route} has an incorrect Content-Type (Nginx MIME acceptance)`);
    const [localBytes, responseBytes] = await Promise.all([
      readFile(resource.file), response.arrayBuffer().then(bytes => Buffer.from(bytes)),
    ]);
    const comparison = compareStaticResponseBytes(localBytes, responseBytes);
    assert.equal(comparison.matches, true,
      `${resource.route} response differs from public source bytes (local sha256 ${comparison.localSha256}, response sha256 ${comparison.responseSha256}; ${comparison.localBytes}/${comparison.responseBytes} bytes)`);
  }
  assert.ok(counts.HTML > 0 && counts.JavaScript > 0 && counts.CSS > 0, 'Static inventory must include HTML, JS/MJS, and CSS.');

  const missingHtml = await fetchStatic(baseOrigin, '/route-recovery-browser-missing-page.html');
  assert.equal(missingHtml.status, 404, 'Unknown HTML must not receive a successful index fallback.');
  const missingModule = await fetchStatic(baseOrigin, '/js/route-recovery-browser-missing-module.mjs');
  assert.equal(missingModule.status, 404, 'Unknown MJS must not receive HTML fallback.');
  const redirect = await fetchStatic(baseOrigin, '/editorial');
  assert.equal(redirect.status, 308, '/editorial must keep the expected redirect status.');
  assert.equal(redirect.headers.get('location'), '/editorial/admin', 'Editorial redirect must remain origin-relative.');

  return { counts };
}

function newGuardLedger(role, solidesLinked) {
  return { role, solidesLinked, events: [], failures: [], pageErrors: [], expectedDenials: [] };
}

function recordFailure(ledger, kind, details) {
  const event = { kind, ...details };
  ledger.events.push(event);
  ledger.failures.push(event);
}

function jsonResponse(result, method) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (Number.isInteger(result.total)) headers['x-total-count'] = String(result.total);
  const body = method === 'HEAD' ? '' : JSON.stringify(result.body);
  return { status: result.status, headers, body };
}

function fixtureBodySummary(body) {
  if (body === null) return { kind: 'null' };
  if (Array.isArray(body)) {
    return {
      kind: 'array', count: body.length,
      firstItemKeys: body[0] && typeof body[0] === 'object' ? Object.keys(body[0]).slice(0, 20) : [],
    };
  }
  if (typeof body === 'object') {
    return {
      kind: 'object', keys: Object.keys(body).slice(0, 24),
      arrayCounts: Object.fromEntries(Object.entries(body)
        .filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
      nestedDataKeys: body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? Object.keys(body.data).slice(0, 20) : undefined,
    };
  }
  return { kind: typeof body };
}

async function visibleFixtureDiagnostics(page, selector, text, ledger) {
  let documentState;
  try {
    documentState = await page.evaluate(targetSelector => {
      let target;
      try { target = document.querySelector(targetSelector); } catch { target = null; }
      const main = document.querySelector('#main-content');
      const visibleText = node => node?.innerText?.trim().slice(0, 800) || '';
      return {
        path: `${location.pathname}${location.search}`,
        title: document.title,
        authState: document.documentElement.dataset.authState || null,
        verifiedRole: document.documentElement.dataset.portalRole || null,
        target: {
          selector: targetSelector, found: Boolean(target),
          visible: Boolean(target && target.getClientRects().length && getComputedStyle(target).visibility !== 'hidden'),
          text: visibleText(target),
        },
        mainText: visibleText(main),
        alerts: [...document.querySelectorAll('[role="alert"]')].slice(0, 5).map(visibleText),
        routeState: document.querySelector('[data-navigation-state]')?.dataset.navigationState || null,
      };
    }, selector);
  } catch (error) {
    documentState = { diagnosticReadError: error.message };
  }
  return {
    expected: { selector, fixtureText: text },
    document: documentState,
    apiEvents: ledger.events.filter(event => event.kind === 'fixture-api' || event.kind === 'unknown-api'
      || event.kind === 'missing-synthetic-auth' || event.kind === 'denied-noncanonical-path')
      .slice(-30),
    guardFailures: ledger.failures.slice(-20),
    pageErrors: ledger.pageErrors.slice(-10).map(error => ({ message: error.message })),
    realModuleResponses: ledger.events.filter(event => event.kind === 'static-module-response').slice(-10),
  };
}

async function installNetworkGuard(context, baseOrigin, ledger) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (url.origin === baseOrigin) {
      const guardedPath = classifyRouteRecoveryPath(url.pathname);
      if (guardedPath.kind === 'unsafe-path') {
        recordFailure(ledger, 'denied-noncanonical-path', {
          method, path: `${url.pathname}${url.search}`, reason: guardedPath.reason,
        });
        if (!['GET', 'HEAD'].includes(method)) {
          recordFailure(ledger, 'denied-write', { method, path: `${url.pathname}${url.search}` });
        }
        await route.fulfill(jsonResponse({ status: 400, body: { error: guardedPath.reason } }, method));
        return;
      }
      if (guardedPath.kind === 'api') {
        if (!['GET', 'HEAD'].includes(method)) {
          recordFailure(ledger, 'denied-write', { method, path: `${url.pathname}${url.search}` });
          await route.fulfill(jsonResponse({ status: 405, body: { error: 'route_recovery_read_only' } }, method));
          return;
        }
        const authorization = request.headers().authorization;
        if (authorization !== `Bearer ${SYNTHETIC_TOKEN}`) {
          recordFailure(ledger, 'missing-synthetic-auth', {
            method, path: `${url.pathname}${url.search}`, responseStatus: 401,
            fixtureReason: 'route_recovery_auth_fixture_required',
          });
          await route.fulfill(jsonResponse({ status: 401, body: { error: 'route_recovery_auth_fixture_required' } }, method));
          return;
        }
        const result = resolveRouteRecoveryAPI({ url, method, role: ledger.role, solidesLinked: ledger.solidesLinked });
        if (result.kind === 'unknown-api' || result.kind === 'denied-write' || result.kind === 'unsafe-path') {
          recordFailure(ledger, result.kind, {
            method, path: `${url.pathname}${url.search}`, responseStatus: result.status,
            fixtureReason: result.body?.error,
          });
        } else if (result.kind === 'fixture') {
          ledger.events.push({
            kind: 'fixture-api', method, path: `${url.pathname}${url.search}`,
            responseStatus: result.status, totalHeader: result.total ?? null,
            body: fixtureBodySummary(result.body),
          });
        } else {
          recordFailure(ledger, 'unclassified-api', { method, path: `${url.pathname}${url.search}`, resultKind: result.kind });
        }
        await route.fulfill(jsonResponse(result, method));
        return;
      }
      if (!['GET', 'HEAD'].includes(method)) {
        recordFailure(ledger, 'denied-static-write', { method, path: `${url.pathname}${url.search}` });
        await route.abort('blockedbyclient');
        return;
      }
      // Continue real public files unchanged. In particular, relative .mjs
      // imports must be fetched from Nginx so their actual MIME is exercised.
      await route.continue();
      return;
    }

    const stub = firebaseStubSource(url);
    if (stub !== null) {
      ledger.events.push({ kind: 'firebase-sdk-stub', method, url: url.href });
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: stub,
      });
      return;
    }

    const expectedReason = expectedBlockedExternalResource(url);
    if (expectedReason) {
      ledger.events.push({ kind: 'expected-denied-external-resource', method, url: url.href, reason: expectedReason });
      ledger.expectedDenials.push({ path: url.href, role: ledger.role, reason: expectedReason });
      await route.abort('blockedbyclient');
      return;
    }
    recordFailure(ledger, 'denied-external-resource', { method, url: url.href });
    await route.abort('blockedbyclient');
  });
}

async function createRoleContext(browser, baseOrigin, { role = 'admin', solidesLinked = true, timeoutMs }) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const ledger = newGuardLedger(role, solidesLinked);
  await context.addInitScript(({ role: initRole, solidesLinked: initSolidesLinked }) => {
    window.__routeRecoveryRole = initRole;
    window.__routeRecoverySolidesLinked = initSolidesLinked;
    window.__routeRecoveryDocumentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }, { role, solidesLinked });
  await installNetworkGuard(context, baseOrigin, ledger);
  context.setDefaultTimeout(timeoutMs);
  context.on('page', page => {
    page.on('pageerror', error => ledger.pageErrors.push({ message: error.message, stack: error.stack }));
  });
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== baseOrigin || url.pathname !== '/js/owner-news/asset-path.mjs') return;
    const contentType = response.headers()['content-type'] || '';
    const details = { path: url.pathname, status: response.status(), contentType };
    ledger.events.push({ kind: 'static-module-response', ...details });
    if (response.status() !== 200 || !JS_MIME.test(contentType)) recordFailure(ledger, 'static-module-mime', details);
  });
  return { context, ledger };
}

async function expectVisibleFixture(page, selector, text, timeoutMs, ledger) {
  const target = page.locator(selector);
  try {
    await page.waitForFunction(({ targetSelector, expectedText }) => {
      const root = document.querySelector(targetSelector);
      if (!root) return false;
      const candidates = [root, ...root.querySelectorAll('*')];
      return candidates.some(node => node.textContent.trim() === expectedText
        && node.getClientRects().length > 0
        && getComputedStyle(node).visibility !== 'hidden'
        && !node.closest('[hidden], [aria-hidden="true"], .hidden, [inert]'));
    }, { targetSelector: selector, expectedText: text }, { timeout: timeoutMs });
    const rendered = await target.innerText();
    assert.ok(rendered.includes(text), `${selector} should contain visible fixture content: ${text}`);
  } catch (error) {
    const diagnostics = await visibleFixtureDiagnostics(page, selector, text, ledger);
    throw new Error(`${error.message}\nRoute-recovery fixture diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`, { cause: error });
  }
}

async function gotoFixture(context, baseOrigin, pathName, selector, text, timeoutMs, ledger) {
  const page = await context.newPage();
  await page.goto(new URL(pathName, baseOrigin).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await expectVisibleFixture(page, selector, text, timeoutMs, ledger);
  return page;
}

async function verifyPositiveRoutes(browser, baseOrigin, timeoutMs) {
  const { context, ledger } = await createRoleContext(browser, baseOrigin, { role: 'admin', timeoutMs });
  const routeCases = [
    ['/dashboard.html', '#dashboard-hero-description', 'Synthetic Owner News body for route-recovery acceptance.'],
    ['/knowledge.html', '#articles-list', 'Synthetic Knowledge Fixture'],
    ['/reminders.html', '#reminders-tbody', 'Synthetic Reminder Fixture'],
    ['/academy.html', '#academy-root', 'Synthetic Academy Course'],
    ['/announcements.html', '#announcements-list', 'Synthetic Owner News Article'],
    [`/news-preview.html?id=${PREVIEW_ID}&version=${PREVIEW_VERSION}&source=payload`, '#news-preview-content', 'Synthetic saved preview body.'],
    ['/benefits.html', '#benefits-content', 'Synthetic Benefits Partner'],
  ];
  const pages = [];
  for (const [route, selector, text] of routeCases) pages.push(await gotoFixture(context, baseOrigin, route, selector, text, timeoutMs, ledger));

  const adminPage = await gotoFixture(context, baseOrigin, '/admin.html', '#users-tbody', 'Synthetic Admin List Fixture', timeoutMs, ledger);
  const originalDocumentId = await adminPage.evaluate(() => window.__routeRecoveryDocumentId);
  await adminPage.locator('a.cms-entry-link[href="./cms.html"]').click();
  await adminPage.waitForURL(url => url.pathname === '/cms.html', { timeout: timeoutMs });
  await expectVisibleFixture(adminPage, '#document-list', 'Synthetic CMS Document Fixture', timeoutMs, ledger);
  const cmsDocumentId = await adminPage.evaluate(() => window.__routeRecoveryDocumentId);
  assert.equal(cmsDocumentId, originalDocumentId, 'Admin → CMS click must preserve the original document.');

  await adminPage.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await adminPage.waitForURL(url => url.pathname === '/admin.html', { timeout: timeoutMs });
  await expectVisibleFixture(adminPage, '#users-tbody', 'Synthetic Admin List Fixture', timeoutMs, ledger);
  assert.equal(await adminPage.evaluate(() => window.__routeRecoveryDocumentId), originalDocumentId,
    'History back from CMS must restore Admin in the same document.');

  await adminPage.goForward({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await adminPage.waitForURL(url => url.pathname === '/cms.html', { timeout: timeoutMs });
  await expectVisibleFixture(adminPage, '#document-list', 'Synthetic CMS Document Fixture', timeoutMs, ledger);
  assert.equal(await adminPage.evaluate(() => window.__routeRecoveryDocumentId), originalDocumentId,
    'History forward to CMS must restore the same document.');

  await adminPage.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await expectVisibleFixture(adminPage, '#document-list', 'Synthetic CMS Document Fixture', timeoutMs, ledger);
  const reloadedDocumentId = await adminPage.evaluate(() => window.__routeRecoveryDocumentId);
  assert.notEqual(reloadedDocumentId, originalDocumentId, 'Explicit reload must create a new document.');
  assert.equal(await adminPage.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'reload',
    'Reload proof must be reported by the browser navigation entry.');
  pages.push(adminPage);

  for (const page of pages) await page.close();
  return { ledger, diagnosedRouteMounts: routeCases.length + 1 };
}

async function verifySupplementalBehavior(browser, baseOrigin, timeoutMs) {
  const linked = await createRoleContext(browser, baseOrigin, { role: 'admin', timeoutMs });
  const solidesPage = await gotoFixture(linked.context, baseOrigin, '/solides.html', '#schedule-summary', 'Synthetic Schedule', timeoutMs, linked.ledger);
  assert.ok((await solidesPage.locator('#punch-history').innerText()).includes('Synthetic fixture'),
    'Sólides should mount fixture punch-history content, not only its shell.');
  await solidesPage.close();

  const unavailable = await createRoleContext(browser, baseOrigin, { role: 'admin', solidesLinked: false, timeoutMs });
  const unavailablePage = await unavailable.context.newPage();
  await unavailablePage.goto(new URL('/solides.html', baseOrigin).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const unavailableAlert = unavailablePage.getByRole('alert');
  await unavailableAlert.waitFor({ state: 'visible', timeout: timeoutMs });
  await unavailableAlert.getByRole('button').waitFor({ state: 'visible', timeout: timeoutMs });
  assert.equal(await unavailablePage.locator('#today-summary').count(), 0,
    'An unlinked Sólides destination must not mount page content behind the recovery view.');
  unavailable.ledger.expectedDenials.push({ path: '/solides.html', role: 'admin', reason: 'synthetic account is unlinked' });
  await unavailablePage.close();

  const entry = await createRoleContext(browser, baseOrigin, { role: 'admin', timeoutMs });
  const entryPage = await entry.context.newPage();
  await entryPage.goto(new URL('/editorial-entry.html', baseOrigin).href,
    { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const expectedAvailabilityMessage = 'Owner News ainda não foi ativada no Payload e o runtime não respondeu à verificação. A entrada está desativada.';
  await expectVisibleFixture(entryPage, '#editorial-entry-status', expectedAvailabilityMessage, timeoutMs, entry.ledger);
  assert.equal((await entryPage.locator('#editorial-entry-status').innerText()).trim(), expectedAvailabilityMessage,
    'Editorial entry must show the semantic message for legacy authority with unavailable runtime.');
  assert.equal(await entryPage.locator('#editorial-enter').isVisible(), false,
    'Editorial entry must remain unavailable while the in-memory availability fixture is inactive.');
  assert.equal(await entryPage.locator('#editorial-recheck').isVisible(), true,
    'Editorial entry must offer an explicit recheck while unavailable.');
  await entryPage.close();

  return [linked.ledger, unavailable.ledger, entry.ledger];
}

async function verifyRoleDenials(browser, baseOrigin, timeoutMs) {
  const { context, ledger } = await createRoleContext(browser, baseOrigin, { role: 'viewer', timeoutMs });
  const deniedCases = [
    ['/cms.html', '#document-list'],
    ['/admin.html', '#admin-tabs'],
    [`/news-preview.html?id=${PREVIEW_ID}&version=${PREVIEW_VERSION}&source=payload`, '#news-preview-content'],
  ];
  for (const [route, protectedSelector] of deniedCases) {
    const page = await context.newPage();
    await page.goto(new URL(route, baseOrigin).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const denial = page.getByRole('alert');
    await denial.waitFor({ state: 'visible', timeout: timeoutMs });
    assert.ok((await denial.innerText()).trim().length > 0, `${route} should explain the denied destination accessibly.`);
    await denial.getByRole('button').waitFor({ state: 'visible', timeout: timeoutMs });
    assert.equal(await page.locator(protectedSelector).count(), 0, `${route} must not mount protected page content for a viewer.`);
    ledger.expectedDenials.push({ path: new URL(route, baseOrigin).pathname, role: 'viewer', reason: 'router access guard' });
    await page.close();
  }
  assert.equal(ledger.events.some(event => event.path?.startsWith('/api/announcements/preview/')), false,
    'Denied preview routes must not request preview data.');
  assert.equal(ledger.events.some(event => event.path?.split('?')[0] === '/api/cms/documents'), false,
    'Denied CMS routes must not request CMS documents.');
  assert.equal(ledger.events.some(event => event.path?.split('?')[0] === '/api/users'), false,
    'Denied Admin routes must not request the Admin user list.');
  return ledger;
}

function assertLedgers(ledgers) {
  const events = ledgers.flatMap(ledger => ledger.events);
  const failures = ledgers.flatMap(ledger => ledger.failures);
  const pageErrors = ledgers.flatMap(ledger => ledger.pageErrors.map(error => ({ role: ledger.role, ...error })));
  assert.deepEqual(failures, [], `Network guard violations are not accepted:\n${JSON.stringify(failures, null, 2)}`);
  assert.deepEqual(pageErrors, [], `Uncaught browser errors are not accepted:\n${JSON.stringify(pageErrors, null, 2)}`);
  const writeAttempts = events.filter(event => event.kind === 'denied-write' || event.kind === 'denied-static-write');
  assert.deepEqual(writeAttempts, [], `No API or static write may be attempted:\n${JSON.stringify(writeAttempts, null, 2)}`);
  return {
    fixtureApiRequests: events.filter(event => event.kind === 'fixture-api').length,
    firebaseSdkStubs: events.filter(event => event.kind === 'firebase-sdk-stub').length,
    expectedExternalBlocks: events.filter(event => event.kind === 'expected-denied-external-resource').length,
    expectedDenials: ledgers.flatMap(ledger => ledger.expectedDenials),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const staticSweep = await sweepNginxStatic(args.baseOrigin);
  const playwright = await loadPlaywright(args.playwrightModule);
  const browser = await playwright.chromium.launch({ headless: true });
  const result = await runWithBoundedBrowserClose(browser, async () => {
    const ledgers = [];
    const positives = await verifyPositiveRoutes(browser, args.baseOrigin, args.timeoutMs);
    assert.equal(positives.diagnosedRouteMounts, 8, 'All eight diagnosed route pages must mount fixture content.');
    ledgers.push(positives.ledger);
    ledgers.push(...await verifySupplementalBehavior(browser, args.baseOrigin, args.timeoutMs));
    ledgers.push(await verifyRoleDenials(browser, args.baseOrigin, args.timeoutMs));

    const report = assertLedgers(ledgers);
    const moduleResponses = ledgers.flatMap(ledger => ledger.events)
      .filter(event => event.kind === 'static-module-response');
    assert.ok(moduleResponses.some(response => response.status === 200 && JS_MIME.test(response.contentType)),
      'Browser must import the real .mjs module from Nginx with JavaScript MIME; it is never stubbed/intercepted.');
    return { report, positives, moduleResponses };
  });
  process.stdout.write([
    'PASS route-recovery browser acceptance',
    `Nginx static GET sweep: ${staticSweep.counts.HTML} HTML, ${staticSweep.counts.JavaScript} JS/MJS, ${staticSweep.counts.CSS} CSS (byte-for-byte source comparison)`,
    `Positive route mounts: ${result.positives.diagnosedRouteMounts} diagnosed routes plus the Admin navigation source; Admin → CMS → back → forward → reload kept the same document until reload.`,
    `Supplemental behavior: linked/unlinked Sólides and unavailable editorial-entry state.`,
    `Expected denials: ${result.report.expectedDenials.length} (including ${result.report.expectedExternalBlocks} known external images blocked); fixture API requests: ${result.report.fixtureApiRequests}; Firebase SDK stubs: ${result.report.firebaseSdkStubs}.`,
    `Real browser .mjs responses: ${result.moduleResponses.length}.`,
    'No API writes, unknown API paths, non-allowlisted external requests, non-canonical request paths, or uncaught browser errors were observed.',
  ].join('\n') + '\n');
}

main().catch(error => {
  const primary = error.stack || error.message || String(error);
  const cleanup = error.cleanupError
    ? `\nSecondary browser cleanup failure: ${error.cleanupError.stack || error.cleanupError.message || String(error.cleanupError)}`
    : '';
  process.stderr.write(`${primary}${cleanup}\n`);
  process.exitCode = 1;
});
