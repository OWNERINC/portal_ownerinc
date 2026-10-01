// TEST FIXTURES ONLY. This module is referenced solely by the documentation
// import map, never by a public production page.
const courses = [
  { id: 'culture', title: 'Nossa cultura, na prática', category: 'Cultura', learning_group: 'initial', icon_key: 'icon-02', instructor_name: 'Equipe Ownerinc' },
  { id: 'tools', title: 'Ferramentas para o dia a dia', category: 'Integração', learning_group: 'initial', icon_key: 'icon-04', instructor_name: 'Equipe Ownerinc' },
  { id: 'service', title: 'Relacionamento com o cliente', category: 'Atendimento', learning_group: 'role', icon_key: 'icon-06', instructor_name: 'Equipe de atendimento' },
].map(course => ({ ...course, delivery_mode: 'internal', active: true, description: 'Conheça as práticas e os recursos que apoiam o trabalho da nossa equipe.', total_lessons: 3, completed_lessons: 1, progress_percent: 33, resume_lesson_id: `${course.id}-2` }));
const lessonTitles = ['Boas-vindas à Ownerinc', 'Da cultura à prática', 'Aplicando no dia a dia'];
const progress = new Map();
export function can() { return false; }
export async function fetchAPIAsset() { throw new Error('Fixture sem assets privados.'); }
export async function fetchAPI(path, options = {}) {
  if (options.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  const url = new URL(path, window.location.origin);
  if (url.pathname.endsWith('/categories')) return ['Cultura', 'Integração', 'Atendimento'];
  if (url.pathname.endsWith('/continue')) return [courses[0]];
  const match = /\/lessons\/([^/]+)(\/progress)?$/.exec(url.pathname);
  if (match) {
    const id = match[1], courseId = id.slice(0, -2), n = Number(id.at(-1));
    const initial = progress.get(id) || { lesson_id: id, media_version: 1, position_seconds: 15, version: 0, completed: n === 1 };
    if (match[2]) {
      const body = JSON.parse(options.body);
      await new Promise(resolve => setTimeout(resolve, 650));
      const saved = { ...initial, ...body, version: initial.version + 1 };
      progress.set(id, saved); return saved;
    }
    return { course_id: courseId, lesson: { id, title: lessonTitles[n - 1], media_version: 1 }, media: { type: 'file', url: 'https://fixture.invalid/lesson.mp4' },
      progress: initial, next_lesson_id: n < 3 ? `${courseId}-${n + 1}` : null,
      description: 'Material demonstrativo. Reflita sobre como os conceitos da aula aparecem na sua rotina.', content_blocks: null };
  }
  const course = courses.find(course => url.pathname.endsWith(`/${course.id}`));
  if (course) return { course, content_blocks: null, modules: [{ id: `${course.id}-module`, title: 'Primeiros passos', lessons: lessonTitles.map((title, i) => ({ id: `${course.id}-${i + 1}`, title, media_version: 1, completed: i === 0 })) }] };
  throw Object.assign(new Error('Fixture não encontrada.'), { status: 404 });
}
export async function fetchAPIPage(path) {
  const query = new URL(path, window.location.origin).searchParams;
  const all = courses.filter(course => course.learning_group === query.get('group') && (!query.get('category') || course.category === query.get('category')));
  return { data: all.slice(Number(query.get('offset') || 0), Number(query.get('offset') || 0) + 20), total: all.length };
}
export async function createLessonPlayer({ host, signal, startSeconds }) {
  const label = document.createElement('p');
  label.textContent = 'Player de teste · área de vídeo 16:9';
  label.style.cssText = 'color:#F6FAF5;margin:0;padding:32px;font:16px Helvetica,Arial,sans-serif';
  host.append(label);
  const destroy = () => label.remove();
  signal.addEventListener('abort', destroy, { once: true });
  return { getPosition: () => startSeconds, pause() {}, seek() {}, destroy };
}
