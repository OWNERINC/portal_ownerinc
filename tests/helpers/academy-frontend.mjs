import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { FixtureNode, parseInto, TestEvent, deferred, drain } from './frontend-feedback-harness.mjs';
export { TestEvent, deferred, drain };
TestEvent.prototype.stopPropagation = function () { this.stopped = true; };

// Runs the production module graph. Only browser DOM, auth/HTTP, timers and media
// transport are seams; view rendering, CMS, API binding and progress are real.
export async function academyHarness({ url = 'https://portal.test/academy.html', manager = false, playerFailures = 0 } = {}) {
  const doc = new FixtureNode('document'); doc.ownerDocument = doc;
  doc.createElement = tag => new FixtureNode(tag, doc);
  doc.createElementNS = (_, tag) => doc.createElement(tag);
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  doc.getElementById = id => doc.querySelector(`#${id}`);
  parseInto(doc, await readFile('public/academy.html', 'utf8'));
  doc.documentElement = doc.querySelector('html');
  doc.body = doc.querySelector('body'); doc.activeElement = doc.body;
  const window = new FixtureNode('window', doc);
  let location = new URL(url), position = 0;
  const entries = [{ url: location.href, state: { portalPosition: 0, custom: 'preserved' } }];
  const history = {
    get state() { return entries[position].state; },
    pushState(state, _, next) { location = new URL(next, location); entries.splice(++position); entries.push({ url: location.href, state }); },
    replaceState(state, _, next) { location = new URL(next, location); entries[position] = { url: location.href, state }; },
    go(delta) { position += delta; location = new URL(entries[position].url); window.dispatchEvent(new TestEvent('popstate')); },
  };
  Object.assign(window, { history, get location() { return location; } }); doc.defaultView = window;
  const requests = [], players = [], timers = new Map(), revoked = [];
  let id = 0;
  const transport = kind => (path, options = {}) => { const pending = { kind, path, options, ...deferred() }; requests.push(pending); return pending.promise; };
  const context = vm.createContext({
    document: doc, window, console, AbortController, DOMException, URLSearchParams, TextEncoder,
    URL: class extends URL { static revokeObjectURL(url) { revoked.push(url); } },
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    fetchAPI: transport('api'), fetchAPIPage: transport('list'), fetchAPIAsset: transport('asset'),
    can: (_user, permission) => manager && permission === 'manageAcademy',
    createLessonPlayer: async options => {
      if (playerFailures-- > 0) throw new Error('Não foi possível reproduzir este vídeo.');
      const handle = { options, destroyed: false, position: options.startSeconds, getPosition() { return this.position; },
        pause() { options.onPause?.(); }, destroy() { this.destroyed = true; } };
      players.push(handle); return handle;
    },
  });
  async function load(file, names) {
    const code = (await readFile(file, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(`(() => { ${code}\nObject.assign(globalThis, { ${names} }); })();`, context, { filename: file });
  }
  await load('public/js/page-lifecycle.js', 'createPageLifecycle');
  await load('public/js/ui.js', 'clear, element, safeHttpUrl');
  await load('public/js/owner-news/asset-path.mjs', 'cmsAssetEndpoint, validateAssetScope');
  await load('public/js/cms-block-renderer.js', 'renderBlocks');
  await load('public/academy/progress-controller.js', 'createProgressController');
  await load('public/academy/api.js', 'createAcademyAPI');
  await load('public/academy/view-utils.js', 'unavailable, heading, button, routeLink, brand, errorState, cover, courseCard, curriculum, externalLink');
  await load('public/academy/catalog-view.js', 'catalogView');
  await load('public/academy/course-view.js', 'courseView');
  await load('public/academy/lesson-view.js', 'lessonView');
  await load('public/academy/app.js', 'mountAcademy');
  context.page = context.createPageLifecycle({ user: { uid: 'test-user' }, history });
  Object.defineProperty(context.page, 'location', { get: () => location });
  context.mountAcademy(context.page);
  await drain();
  return {
    doc, window, requests, players, timers, revoked, history, entries, page: context.page,
    get location() { return location; }, root: doc.getElementById('academy-root'),
    latest(fragment) { return [...requests].reverse().find(request => request.path.includes(fragment)); },
    async navigate(query) { history.pushState(history.state, '', `?${query}`); window.dispatchEvent(new TestEvent('popstate')); await drain(); },
    async resolve(fragment, value) { this.latest(fragment).resolve(value); await drain(); },
    button(text) { return doc.querySelectorAll('button').find(node => node.textContent === text); },
    link(text) { return doc.querySelectorAll('a').find(node => node.textContent === text); },
  };
}

export const course = (id = 'course-a', overrides = {}) => ({ id, title: 'Cultura Ownerinc', category: 'Cultura', description: 'Nossa forma de trabalhar.',
  delivery_mode: 'internal', active: true, icon_key: 'icon-02', total_lessons: 2, completed_lessons: 0, ...overrides });
export function courseData(id = 'course-a', overrides = {}) {
  return { course: course(id, overrides), content_blocks: null, modules: [{ id: 'module-a', title: 'Primeiros passos', lessons: [
    { id: 'lesson-a', title: 'Boas-vindas', media_version: 1 }, { id: 'lesson-b', title: 'Nosso jeito', media_version: 1 },
  ] }] };
}
export const lessonData = (id = 'lesson-a', overrides = {}) => ({ course_id: 'course-a', lesson: { id, title: id === 'lesson-a' ? 'Boas-vindas' : 'Nosso jeito', media_version: 1 },
  media: { type: 'file', url: 'https://media.test/welcome.mp4' }, content_blocks: null, description: 'Material da aula.', next_lesson_id: 'lesson-b',
  progress: { lesson_id: id, media_version: 1, position_seconds: 12, completed: false, version: 0 }, ...overrides });
