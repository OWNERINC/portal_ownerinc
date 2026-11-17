import { can, fetchAPI, fetchAPIPage } from '../js/auth.js';
import { element } from '../js/ui.js';
import { createCourseEditor } from './course-editor.js';
import { createCurriculumEditor } from './curriculum-editor.js';
import { button, routeLink } from './view-utils.js';

export function mountAcademyManager({ root, page, courseId, newCourse = false, navigate = () => {} } = {}) {
  let editor = null, curriculum = null, disposed = false, loading = false, navigating = false;
  if (!root || !can(page?.user, 'manageAcademy')) { root?.replaceChildren(element('p', { role: 'status', text: 'Este conteúdo não está disponível para seu perfil.' })); return () => {}; }
  const query = new URL(page.location.href).searchParams;
  const rawOffset = query.get('manage_offset');
  const parsedOffset = /^\d+$/.test(rawOffset || '') ? Number(rawOffset) : 0;
  // Keep URL normalization within the API pagination contract (max 1,000,000).
  let offset = Number.isSafeInteger(parsedOffset) && parsedOffset <= 1000000 ? Math.floor(parsedOffset / 20) * 20 : 0;
  const live = () => !disposed && page.active;
  const managerParams = extra => ({ manage: '1', manage_offset: String(offset), ...extra });
  function replaceOffset() {
    const url = new URL(page.location.href);
    url.searchParams.set('manage_offset', String(offset));
    page.history.replaceState(window.history.state, '', url);
  }
  if (rawOffset !== null && rawOffset !== String(offset)) replaceOffset();
  const shell = element('div', { className: 'academy-manager' }); root.replaceChildren(shell);
  const heading = element('h1', { text: courseId ? 'Gerenciar curso' : 'Gerenciar Academy', tabindex: '-1' }); shell.append(heading);
  const status = element('p', { role: 'status', text: 'Carregando cursos…' }); shell.append(status);
  const content = element('div'); shell.append(content);
  const pagination = element('nav', { className: 'academy-pagination', 'aria-label': 'Páginas da gestão Academy' });
  const dirty = () => editor?.isDirty() || curriculum?.isDirty();
  const busy = () => editor?.isSaving() || curriculum?.isSaving();
  page.beforeLeave(() => {
    if (disposed) return true;
    if (busy()) { page.toast('Aguarde a operação em andamento terminar.'); return false; }
    return !dirty() || window.confirm('Há alterações da Academy que ainda não foram salvas. Sair mesmo assim?');
  });
  page.listen(window, 'beforeunload', event => {
    if (!dirty() && !busy()) return;
    event.preventDefault(); event.returnValue = '';
  });
  async function changePage(nextOffset) {
    if (!live() || loading || navigating) return;
    navigating = true;
    for (const control of pagination.querySelectorAll('button')) control.disabled = true;
    try { await navigate(managerParams({ manage_offset: String(nextOffset) })); }
    finally {
      navigating = false;
      if (live()) for (const control of pagination.querySelectorAll('button')) control.disabled = false;
    }
  }
  async function load() {
    if (!live() || loading) return;
    loading = true;
    const previousFocus = document.activeElement;
    const retryFocused = content.contains(previousFocus);
    content.replaceChildren(); pagination.replaceChildren();
    shell.setAttribute('aria-busy', 'true');
    status.textContent = 'Carregando cursos…';
    try {
      if (courseId) {
        const view = await page.bindAPI({ fetchAPI, fetchAPIPage }).fetchAPI(`/api/academy/${encodeURIComponent(courseId)}?all=true`);
        if (!live()) return;
        const course = { ...(view.course || view), modules: view.modules || view.course?.modules || [] };
        let deliveryMode = course.delivery_mode;
        const externalHelp = () => {
          if (!shell.querySelector('.academy-external-help')) shell.append(element('p', { className: 'academy-manager-help academy-external-help', role: 'status', text: 'Curso externo: somente os metadados e a URL podem ser editados. Módulos e aulas pertencem ao curso interno.' }));
        };
        const courseRoot = element('div'); shell.append(courseRoot);
        editor = createCourseEditor({ root: courseRoot, page, course, registerGuard: false,
          onCancel: () => navigate(managerParams()),
          beforeSave: body => body.delivery_mode !== deliveryMode && (curriculum?.isDirty() || curriculum?.isSaving())
            ? 'Salve as alterações do currículo antes de mudar a entrega do curso.' : '',
          onSavingChange: saving => curriculum?.setLocked(saving),
          onSaved: saved => {
            deliveryMode = saved.delivery_mode;
            if (saved.delivery_mode === 'internal' && !curriculum) {
              curriculum = createCurriculumEditor({ root: shell, page, courseId, registerGuard: false });
              shell.querySelector('.academy-external-help')?.remove();
            } else if (saved.delivery_mode === 'external') {
              curriculum?.dispose(); curriculum = null; externalHelp();
            }
          } });
        if (course.delivery_mode === 'internal') {
          curriculum = createCurriculumEditor({ root: shell, page, courseId, initialCourse: course, registerGuard: false });
        } else externalHelp();
        status.remove(); return;
      }
      if (newCourse) {
        const courseRoot = element('div'); shell.append(courseRoot); status.remove();
        editor = createCourseEditor({ root: courseRoot, page, registerGuard: false,
          onCancel: () => navigate(managerParams()),
          onSaved: saved => { if (saved?.id) navigate(managerParams({ course: saved.id })); } });
        return;
      }
      const api = page.bindAPI({ fetchAPI, fetchAPIPage });
      let result = await api.fetchAPIPage(`/api/academy?all=true&limit=20&offset=${offset}`);
      if (!live()) return;
      const lastOffset = total => Math.max(0, Math.ceil(total / 20) - 1) * 20;
      if (offset > lastOffset(result.total)) {
        offset = lastOffset(result.total); replaceOffset();
        result = await api.fetchAPIPage(`/api/academy?all=true&limit=20&offset=${offset}`);
        if (!live()) return;
        // One corrective read per attempt, even if other managers keep deleting.
        if (offset > lastOffset(result.total)) throw new Error('Catálogo alterado durante a leitura.');
      }
      status.textContent = `Página ${offset / 20 + 1} de ${Math.max(1, Math.ceil(result.total / 20))} · ${result.total} cursos`;
      const list = element('div', { className: 'academy-manager-list' });
      for (const course of result.data || []) {
        const manage = routeLink(course.delivery_mode === 'internal' ? 'Gerenciar curso' : 'Editar curso externo', managerParams({ course: course.id }), navigate, { className: 'academy-button academy-button-small' });
        list.append(element('article', { className: 'academy-manager-course' }, [element('h2', { text: course.title }), element('p', { text: `${course.category || 'Sem categoria'} · ${course.active ? 'Disponível' : 'Rascunho'}` }), manage]));
      }
      if (!result.data?.length) list.append(element('p', { text: 'Nenhum curso cadastrado.' }));
      if (offset > 0) pagination.append(button('Anterior', () => changePage(offset - 20)));
      if (offset + 20 < result.total) pagination.append(button('Próxima', () => changePage(offset + 20)));
      content.append(list, pagination, routeLink('Novo curso', managerParams({ new: '1' }), navigate, { className: 'academy-button' }));
    } catch (error) {
      if (!live()) return;
      status.textContent = error.status === 403 ? 'Você não tem permissão para gerenciar a Academy.' : 'Não foi possível carregar os cursos.';
      if (error.status !== 403) content.append(button('Tentar novamente', load));
    } finally {
      loading = false;
      if (live()) {
        shell.setAttribute('aria-busy', 'false');
        if (retryFocused && (document.activeElement === previousFocus || document.activeElement === document.body)) heading.focus();
      }
    }
  }
  void load();
  return () => { disposed = true; editor?.dispose(); curriculum?.dispose(); shell.replaceChildren(); };
}
