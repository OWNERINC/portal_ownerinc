import { can } from '../js/auth.js';
import { element } from '../js/ui.js';
import { createPageLifecycle } from '../js/page-lifecycle.js';
import { createAcademyAPI } from './api.js';
import { catalogView } from './catalog-view.js';
import { courseView } from './course-view.js';
import { lessonView } from './lesson-view.js';
import { mountAcademyManager } from './manage-view.js';
import { brand, heading, errorState, routeLink, unavailable } from './view-utils.js';
import { loadBrandAssets } from './brand.js';

function canonicalRouteId(value) {
  // Match the API UUID grammar; malformed values remain unchanged for rejection,
  // rather than being repaired by trimming, removing braces or loose parsing.
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : value;
}

export function mountAcademy(page) {
  const root = document.getElementById('academy-root');
  if (!root) return;
  let scope = null, view = null, generation = 0, brandAssets = null, catalogEntryPending = true;
  if (typeof fetch === 'function') loadBrandAssets({ signal: page.signal }).then(assets => {
    brandAssets = assets;
    if (!page.active) return;
    view?.setBrandAssets?.(assets);
    const mark = root.querySelector('.academy-brand > img');
    if (mark) { const next = brand(assets).firstChild; mark.replaceWith(next); }
  }).catch(() => {});
  function catalogParams() {
    try {
      const url = new URL(window.history.state?.academyCatalog || './academy.html', page.location.href);
      if (url.origin !== page.location.origin || !url.pathname.endsWith('/academy.html')) return {};
      const params = Object.fromEntries(url.searchParams);
      delete params.course; delete params.lesson; delete params.manage; delete params.preview;
      return params;
    } catch { return {}; }
  }
  async function navigate(params) {
    if (!page.active) return;
    if (page.busy) { page.toast('Aguarde a operação em andamento terminar.'); return; }
    const current = new URL(page.location.href);
    const state = { ...window.history.state };
    if (!current.searchParams.has('course') && !current.searchParams.has('lesson')) state.academyCatalog = current.href;
    const url = new URL('./academy.html', current);
    url.search = new URLSearchParams(params).toString();
    // Flush before committing the URL. A second click invalidates the first transition.
    const token = ++generation;
    if (await view?.beforeNavigate?.() === false || token !== generation || !page.active) return;
    page.history.pushState(state, '', url);
    render(true, true);
  }
  async function render(focus = false, alreadyFlushed = false) {
    const token = ++generation;
    if (!alreadyFlushed && view?.beforeNavigate && await view.beforeNavigate() === false) return;
    if (token !== generation || !page.active) return;
    view?.dispose(); scope?.dispose(); view = null;
    scope = createPageLifecycle({ user: page.user });
    const currentScope = scope;
    scope.location = page.location;
    scope.brandAssets = brandAssets;
    // Keep explicit reads in Portal.ready() while also cancelling each route.
    const api = createAcademyAPI({ bindAPI: page.bindAPI, signal: scope.signal });
    const params = new URL(page.location.href).searchParams;
    const courseId = canonicalRouteId(params.get('course')), lessonId = canonicalRouteId(params.get('lesson'));
    const preview = params.get('preview') === '1';
    const live = () => token === generation && page.active && currentScope.active;
    root.setAttribute('aria-busy', 'true');
    try {
      if (params.has('manage')) {
        if (!can(page.user, 'manageAcademy')) throw Object.assign(new Error(unavailable), { status: 403 });
        const managerRoot = element('div'); root.replaceChildren(brand(brandAssets), managerRoot, routeLink('Voltar aos cursos', {}, navigate));
        const disposeManager = mountAcademyManager({ root: managerRoot, page: scope, courseId, newCourse: params.get('new') === '1' });
        scope.cleanup(disposeManager);
      } else if (preview && !can(page.user, 'manageAcademy')) {
        throw Object.assign(new Error(unavailable), { status: 404 });
      } else if (!courseId && !lessonId) {
        view = catalogView({ root, page: scope, focusPage: page, api, navigate, entryMotion: catalogEntryPending });
        catalogEntryPending = false;
      } else {
        root.replaceChildren(heading(lessonId ? 'Carregando aula…' : 'Carregando curso…'),
          element('div', { className: lessonId ? 'academy-player' : 'academy-course-loading' }), element('p', { role: 'status', text: 'Carregando conteúdo…' }));
        if (!courseId) throw Object.assign(new Error(unavailable), { status: 404 });
        const CourseView = await api.course(courseId, preview);
        if (!live()) return;
        if (lessonId) {
          // Never instantiate media for a mismatched or inaccessible curriculum.
          if (canonicalRouteId(CourseView.course.id) !== courseId || CourseView.course.delivery_mode !== 'internal'
            || !CourseView.modules.some(module => module.lessons.some(lesson => canonicalRouteId(lesson.id) === lessonId))) {
            throw Object.assign(new Error(unavailable), { status: 404 });
          }
          const LessonView = await api.lesson(lessonId, preview);
          if (!live()) return;
          if (canonicalRouteId(LessonView.course_id) !== courseId || canonicalRouteId(LessonView.lesson.id) !== lessonId) throw Object.assign(new Error(unavailable), { status: 404 });
          view = lessonView({ root, page: scope, ownerPage: page, api, navigate, LessonView, CourseView, preview });
        } else view = courseView({ root, page: scope, api, navigate, CourseView, preview, catalogParams: catalogParams() });
      }
    } catch (error) {
      if (!live()) return;
      const state = element('div');
      root.replaceChildren(heading('Ownerinc Academy'), state, routeLink('Voltar aos cursos', catalogParams(), navigate));
      errorState(state, error, () => render(true));
    } finally {
      if (live()) {
        root.setAttribute('aria-busy', 'false');
        // Catalog navigation owns focus restoration when a filter or pager initiated
        // the route change. Focusing the heading here would hide that intent and
        // make the async catalog response look like a user focus change.
        if (focus && !page.academyCatalogFocus) root.querySelector('h1')?.focus();
      }
    }
  }
  page.listen(window, 'popstate', () => { void render(true); });
  page.cleanup(() => { ++generation; view?.dispose(); scope?.dispose(); });
  render();
}
