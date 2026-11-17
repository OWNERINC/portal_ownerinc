import { can, fetchAPI, fetchAPIPage } from '../js/auth.js';
import { element } from '../js/ui.js';
import { createCourseEditor } from './course-editor.js';
import { createCurriculumEditor } from './curriculum-editor.js';

export function mountAcademyManager({ root, page, courseId, newCourse = false, navigate = () => {} } = {}) {
  let editor = null, curriculum = null, disposed = false;
  if (!root || !can(page?.user, 'manageAcademy')) { root?.replaceChildren(element('p', { role: 'status', text: 'Este conteúdo não está disponível para seu perfil.' })); return () => {}; }
  const shell = element('div', { className: 'academy-manager' }); root.replaceChildren(shell);
  const heading = element('h1', { text: courseId ? 'Gerenciar curso' : 'Gerenciar Academy' }); shell.append(heading);
  const status = element('p', { role: 'status', text: 'Carregando cursos…' }); shell.append(status);
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
  async function load() {
    try {
      if (courseId) {
        const view = await page.bindAPI({ fetchAPI, fetchAPIPage }).fetchAPI(`/api/academy/${encodeURIComponent(courseId)}?all=true`);
        if (disposed) return;
        const course = { ...(view.course || view), modules: view.modules || view.course?.modules || [] };
        let deliveryMode = course.delivery_mode;
        const externalHelp = () => {
          if (!shell.querySelector('.academy-external-help')) shell.append(element('p', { className: 'academy-manager-help academy-external-help', role: 'status', text: 'Curso externo: somente os metadados e a URL podem ser editados. Módulos e aulas pertencem ao curso interno.' }));
        };
        const courseRoot = element('div'); shell.append(courseRoot);
        editor = createCourseEditor({ root: courseRoot, page, course, registerGuard: false,
          onCancel: () => navigate({ manage: '1' }),
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
          onCancel: () => navigate({ manage: '1' }),
          onSaved: saved => { if (saved?.id) navigate({ manage: '1', course: saved.id }); } });
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
  return () => { disposed = true; editor?.dispose(); curriculum?.dispose(); shell.replaceChildren(); };
}
