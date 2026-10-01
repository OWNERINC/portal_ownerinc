import { can, fetchAPI, fetchAPIPage } from '../js/auth.js';
import { element } from '../js/ui.js';
import { createCourseEditor } from './course-editor.js';
import { createCurriculumEditor } from './curriculum-editor.js';

export async function ensureLessonDocument(lesson, requestOrPage) {
  const request = requestOrPage?.fetchAPI ? requestOrPage : requestOrPage.bindAPI({ fetchAPI, fetchAPIPage });
  const sourceId = lesson.id;
  const listed = await request.fetchAPIPage(`/api/cms/documents?type=academy_lesson&source_id=${encodeURIComponent(sourceId)}&limit=100&offset=0`);
  const existing = (listed.data || []).find(doc => doc.content_type === 'academy_lesson' && String(doc.source_id).toLowerCase() === String(sourceId).toLowerCase());
  if (existing) return existing.id;
  const created = await request.fetchAPI('/api/cms/documents', { method: 'POST', body: JSON.stringify({ type: 'academy_lesson', title: lesson.title || 'Aula', category: 'Academy', source_id: sourceId }) });
  return created.document?.id || created.id;
}

export function mountAcademyManager({ root, page, courseId, newCourse = false } = {}) {
  let editor = null, disposed = false;
  if (!root || !can(page?.user, 'manageAcademy')) { root?.replaceChildren(element('p', { role: 'status', text: 'Este conteúdo não está disponível para seu perfil.' })); return () => {}; }
  const shell = element('div', { className: 'academy-manager' }); root.replaceChildren(shell);
  const heading = element('h1', { text: courseId ? 'Gerenciar curso' : 'Gerenciar Academy' }); shell.append(heading);
  const status = element('p', { role: 'status', text: 'Carregando cursos…' }); shell.append(status);
  async function load() {
    try {
      if (courseId) {
        const course = await page.bindAPI({ fetchAPI, fetchAPIPage }).fetchAPI(`/api/academy/${encodeURIComponent(courseId)}?all=true`);
        if (disposed) return;
        const courseRoot = element('div'); shell.append(courseRoot);
        editor = createCourseEditor({ root: courseRoot, page, course, onSaved: () => window.location.reload() });
        createCurriculumEditor({ root: shell, page, courseId, onSaved: () => {}, ensureLessonDocument: lesson => ensureLessonDocument(lesson, page) });
        status.remove(); return;
      }
      if (newCourse) {
        const courseRoot = element('div'); shell.append(courseRoot); status.remove();
        editor = createCourseEditor({ root: courseRoot, page, onSaved: saved => { if (saved?.id) window.location.href = `./academy.html?manage=1&course=${encodeURIComponent(saved.id)}`; } });
        return;
      }
      const result = await page.bindAPI({ fetchAPI, fetchAPIPage }).fetchAPIPage('/api/academy?all=true&limit=100&offset=0');
      if (disposed) return;
      status.remove();
      const list = element('div', { className: 'academy-manager-list' });
      for (const course of result.data || []) {
        const manage = element('a', { className: 'academy-button academy-button-small', href: `./academy.html?manage=1&course=${encodeURIComponent(course.id)}`, text: course.delivery_mode === 'internal' ? 'Gerenciar curso' : 'Editar curso externo' });
        list.append(element('article', { className: 'academy-manager-course' }, [element('h2', { text: course.title }), element('p', { text: `${course.category || 'Sem categoria'} · ${course.active ? 'Disponível' : 'Rascunho'}` }), manage]));
      }
      shell.append(list, element('a', { className: 'academy-button', href: './academy.html?manage=1&new=1', text: 'Novo curso' }));
    } catch (error) { status.textContent = error.status === 403 ? 'Você não tem permissão para gerenciar a Academy.' : 'Não foi possível carregar os cursos.'; }
  }
  void load();
  return () => { disposed = true; editor?.dispose(); shell.replaceChildren(); };
}
