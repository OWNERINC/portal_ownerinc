import { element } from '../js/ui.js';
import { heading, cover, curriculum, routeLink, externalLink, hydrateBrandAssets } from './view-utils.js';

export function courseView({ root, page, navigate, CourseView, preview = false, catalogParams = {} }) {
  const course = CourseView.course;
  const copy = element('div', { className: 'academy-course-copy' });
  const content = element('div', { className: 'academy-course-content' }, [cover(course, page, page.brandAssets),
    element('h2', { text: 'Sobre o curso' }),
    element('div', { className: 'academy-course-description', text: course.description || 'Descrição não informada.' }),
  ]);
  if (course.instructor_name) content.append(element('p', { text: `Com ${course.instructor_name}` }));
  if (course.delivery_mode === 'external') copy.append(element('p', { text: 'Este curso acontece em uma plataforma externa.' }), externalLink(course));
  else {
    const total = Math.max(0, Number(course.total_lessons) || 0);
    const completed = Math.min(total, Math.max(0, Number(course.completed_lessons) || 0));
    copy.append(element('h2', { text: 'Seu progresso' }), element('p', { text: `${completed} de ${total} aulas concluídas` }));
    if (total) copy.append(element('progress', { className: 'academy-progress', value: completed, max: total, 'aria-label': `Progresso: ${course.title}` }));
    const lessons = CourseView.modules.flatMap(module => module.lessons);
    const first = lessons.find(lesson => lesson.id === course.resume_lesson_id) || lessons[0];
    if (first) copy.append(routeLink(course.resume_lesson_id ? 'Continuar curso' : 'Começar curso',
      { course: course.id, lesson: first.id, ...(preview ? { preview: '1' } : {}) }, navigate, { className: 'academy-button' }));
    else copy.append(element('p', { text: 'Nenhuma aula disponível. Volte aos cursos para continuar aprendendo.' }));
    content.append(element('h2', { text: 'Conteúdo do curso' }), curriculum(CourseView, navigate, null, preview));
  }
  root.replaceChildren(routeLink('← Voltar aos cursos', catalogParams, navigate), heading(course.title),
    element('p', { className: 'academy-course-category', text: course.category || 'Formação' }),
    element('section', { className: 'academy-course-header' }, [content, copy]));
  return { setBrandAssets(assets) { hydrateBrandAssets(root, assets); }, dispose() {} };
}
