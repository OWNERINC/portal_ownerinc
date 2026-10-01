import { element } from '../js/ui.js';
import { renderBlocks } from '../js/cms-block-renderer.js';
import { heading, cover, curriculum, routeLink, externalLink, hydrateBrandAssets } from './view-utils.js';

export function courseView({ root, page, navigate, CourseView, preview = false, catalogParams = {} }) {
  const course = CourseView.course;
  const copy = element('div', { className: 'academy-course-copy' });
  copy.append(heading(course.title));
  if (course.instructor_name) copy.append(element('p', { text: `Com ${course.instructor_name}` }));
  const content = element('div', { className: 'cms-public-content' });
  renderBlocks(content, CourseView.content_blocks, { fallbackText: course.description || '', signal: page.signal });
  copy.append(content);
  if (course.delivery_mode === 'external') copy.append(element('p', { text: 'Este curso acontece em uma plataforma externa.' }), externalLink(course));
  else {
    const lessons = CourseView.modules.flatMap(module => module.lessons);
    const first = lessons.find(lesson => lesson.id === course.resume_lesson_id) || lessons[0];
    if (first) copy.append(routeLink(course.resume_lesson_id ? 'Continuar curso' : 'Começar curso',
      { course: course.id, lesson: first.id, ...(preview ? { preview: '1' } : {}) }, navigate, { className: 'academy-button' }));
    else copy.append(element('p', { text: 'Nenhuma aula disponível. Volte aos cursos para continuar aprendendo.' }));
  }
  root.replaceChildren(routeLink('← Voltar aos cursos', catalogParams, navigate),
    element('section', { className: 'academy-course-header' }, [cover(course, page, page.brandAssets), copy]));
  if (course.delivery_mode === 'internal') root.append(element('h2', { text: 'Conteúdo do curso' }), curriculum(CourseView, navigate, null, preview));
  return { setBrandAssets(assets) { hydrateBrandAssets(root, assets); }, dispose() {} };
}
