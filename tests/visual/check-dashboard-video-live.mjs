// Opt-in live YouTube smoke. Local UI/auth fixtures; no production writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.DASHBOARD_VIDEO_LIVE !== 'true') throw new Error('Set DASHBOARD_VIDEO_LIVE=true to allow live YouTube contact');
for (const name of ['PLAYWRIGHT_MODULE_PATH', 'DASHBOARD_VIDEO_OUTPUT']) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
const output = resolve(process.env.DASHBOARD_VIDEO_OUTPUT);
await mkdir(output);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const csp = (await readFile('nginx/nginx.conf', 'utf8')).match(/add_header Content-Security-Policy "([^"]+)"/)[1];
const server = spawn(process.execPath, [fileURLToPath(new URL('./serve-conecta.mjs', import.meta.url))], {
  env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, page, origin;
const results = { videoId: 'VAhBJOKc3-s', startedAt: new Date().toISOString(), playback: 'NOT_PROVEN',
  limits: 'Real YouTube on loopback with production CSP. Auth/API use explicit local fixtures; not a production session or physical mobile test.' };
const videoRequests = [], errors = [];
try {
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local preview startup timeout')), 10000);
    const fail = error => { clearTimeout(timer); reject(error); };
    server.once('error', fail);
    server.once('exit', code => fail(new Error(`Preview exited before ready: ${code}`)));
    let text = '';
    server.stdout.on('data', chunk => {
      text += chunk;
      const url = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) { clearTimeout(timer); resolve(url); }
    });
  });
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  await context.route('**/dashboard.html', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': csp } });
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/(?:youtube|youtu\.be|ytimg|googlevideo)/.test(new URL(request.url()).hostname)) videoRequests.push(request.url());
  });
  await page.goto(`${origin}/dashboard.html`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#dashboard-video-frame iframe').count(), 0);
  assert.deepEqual(videoRequests, []);
  results.noInitialYouTubeContact = true;
  const navigation = page.waitForEvent('framenavigated', {
    predicate: frame => frame.url().startsWith('https://www.youtube-nocookie.com/embed/VAhBJOKc3-s'),
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Carregar vídeo', exact: true }).click();
  const frame = await navigation;
  results.iframeNavigated = true;
  await frame.getByRole('button', { name: /^(Assistir vídeo|Reproduzir|Play|Play video)$/i }).first().click({ timeout: 30000 });
  await frame.waitForFunction(() => {
    const video = document.querySelector('video');
    const player = document.querySelector('#movie_player');
    return video && video.currentTime >= 2 && !video.paused && !player?.classList.contains('ad-showing');
  }, null, { timeout: 45000 });
  results.media = await frame.evaluate(() => {
    const video = document.querySelector('video'), player = document.querySelector('#movie_player');
    return { currentTime: video.currentTime, duration: video.duration, paused: video.paused,
      adShowing: player?.classList.contains('ad-showing'),
      title: document.querySelector('.ytp-title-link, .ytmVideoInfoVideoTitle')?.textContent
        || document.body.innerText.split('\n').find(line => line.includes('Owntime Home Club Gramado')) || document.title };
  });
  assert.match(results.media.title || '', /Owntime Home Club Gramado/);
  results.playback = 'STARTED';
  await page.screenshot({ path: join(output, 'live-player.png'), fullPage: true });
} catch (error) {
  results.error = error.message;
  if (page) {
    results.frames = await Promise.all(page.frames().map(async frame => ({
      url: frame.url(), text: await frame.locator('body').innerText({ timeout: 2000 }).catch(() => 'Frame body unavailable'),
      controls: await frame.locator('button, [role="button"]').evaluateAll(nodes => nodes.map(node => ({
        tag: node.tagName, label: node.getAttribute('aria-label'), title: node.getAttribute('title'), className: node.className,
      }))).catch(() => []),
    })));
    await page.screenshot({ path: join(output, 'live-player-unverified.png'), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  results.finishedAt = new Date().toISOString();
  results.videoRequestCount = videoRequests.length;
  results.errors = errors;
  await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}
