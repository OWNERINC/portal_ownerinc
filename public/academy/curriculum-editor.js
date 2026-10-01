import { fetchAPI, fetchAPIPage } from '../js/auth.js';
import { element } from '../js/ui.js';

export function createCurriculumEditor({ root, page, courseId, initialCourse = null, onSaved = () => {}, ensureLessonDocument = async () => null }) {
  const request = page.bindAPI({ fetchAPI, fetchAPIPage });
  let dirty = false, saving = false, disposed = false, course = initialCourse;
  const controller = new AbortController();
  let loadController = null, loadToken = 0;
  const panel = element('section', { className: 'academy-curriculum-editor', 'aria-live': 'polite' });
  root.append(panel);
  const feedback = element('p', { className: 'academy-manager-feedback', role: 'alert' });
  panel.append(element('h2', { text: 'Módulos e aulas' }), feedback);
  function markDirty() { dirty = true; }
  async function save(endpoint, method, body) {
    if (saving || disposed) return null;
    saving = true; feedback.textContent = ''; try { const result = await request.fetchAPI(endpoint, { method, body: JSON.stringify(body), signal: controller.signal }); if (disposed) return null; dirty = false; onSaved(result); return result; } catch (error) { if (!disposed && error?.name !== 'AbortError') feedback.textContent = `Não foi possível salvar: ${error?.message || 'erro desconhecido'}`; return null; } finally { saving = false; }
  }
  async function reload() { course = null; panel.querySelector('.academy-modules')?.remove(); await load(); }
  function lessonRow(lesson) {
    const title = element('input', { className: 'academy-manager-input', value: lesson.title, maxlength: '200', 'aria-label': `Título da aula ${lesson.title}` });
    const media = element('input', { className: 'academy-manager-input', value: lesson.media_type === 'youtube' ? `https://www.youtube.com/watch?v=${lesson.youtube_video_id}` : lesson.media_url || '', maxlength: '2048', 'aria-label': `Vídeo da aula ${lesson.title}` });
    const active = element('input', { type: 'checkbox', checked: lesson.active, 'aria-label': `Aula ativa ${lesson.title}` });
    const saveButton = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Salvar aula' });
    const material = element('a', { className: 'academy-button academy-button-small', href: '#', text: 'Materiais' });
    saveButton.addEventListener('click', async () => { markDirty(); await save(`/api/academy/lessons/${encodeURIComponent(lesson.id)}`, 'PUT', { title: title.value.trim(), description: lesson.description || '', order: lesson.order, active: active.checked, media: { type: /youtube\.com|youtu\.be/i.test(media.value) ? 'youtube' : 'file', url: media.value.trim() } }); });
    let documentBusy = false;
    material.addEventListener('click', async event => { event.preventDefault(); if (disposed || documentBusy) return; documentBusy = true; material.setAttribute('aria-busy', 'true'); material.setAttribute('aria-disabled', 'true');
      try { const id = await ensureLessonDocument(lesson, request, { signal: controller.signal }); if (!disposed && id) window.location.href = `./cms.html?type=academy_lesson&document=${encodeURIComponent(id)}`; } catch (error) { if (!disposed && error?.name !== 'AbortError') feedback.textContent = 'Não foi possível abrir os materiais. Tente novamente.'; } finally { documentBusy = false; material.removeAttribute('aria-busy'); material.removeAttribute('aria-disabled'); }
    });
    const up = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Subir', 'aria-label': `Mover aula ${lesson.title} para cima` });
    const down = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Descer', 'aria-label': `Mover aula ${lesson.title} para baixo` });
    const module = course.modules.find(item => item.lessons?.some(itemLesson => itemLesson.id === lesson.id));
    const move = async delta => {
      const ids = [...(module?.lessons || [])].sort((a, b) => a.order - b.order).map(item => item.id);
      const index = ids.indexOf(lesson.id), next = index + delta;
      if (index < 0 || next < 0 || next >= ids.length) return;
      [ids[index], ids[next]] = [ids[next], ids[index]]; markDirty();
      await save(`/api/academy/modules/${encodeURIComponent(module.id)}/lessons/order`, 'PUT', { ids }); await reload();
    };
    up.addEventListener('click', () => void move(-1)); down.addEventListener('click', () => void move(1));
    return element('li', { className: 'academy-manager-item' }, [title, media, active, saveButton, material, up, down]);
  }
  function render() {
    if (!course || disposed) return;
    const list = element('div', { className: 'academy-modules' });
    const addModule = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Adicionar módulo' });
    addModule.addEventListener('click', async () => { const title = window.prompt('Nome do módulo'); if (title?.trim()) { await save(`/api/academy/${encodeURIComponent(courseId)}/modules`, 'POST', { title: title.trim(), order: (course.modules || []).length, active: false }); await reload(); } });
    list.append(addModule);
    for (const module of course.modules || []) {
      const heading = element('input', { className: 'academy-manager-input', value: module.title, maxlength: '200', 'aria-label': `Título do módulo ${module.title}` });
      const active = element('input', { type: 'checkbox', checked: module.active, 'aria-label': `Módulo ativo ${module.title}` });
      const saveModule = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Salvar módulo' });
      saveModule.addEventListener('click', () => { markDirty(); void save(`/api/academy/modules/${encodeURIComponent(module.id)}`, 'PUT', { title: heading.value.trim(), order: module.order, active: active.checked }); });
      const moveModule = async delta => {
        const ids = [...(course.modules || [])].sort((a, b) => a.order - b.order).map(item => item.id);
        const index = ids.indexOf(module.id), next = index + delta;
        if (index < 0 || next < 0 || next >= ids.length) return;
        [ids[index], ids[next]] = [ids[next], ids[index]]; markDirty();
        await save(`/api/academy/${encodeURIComponent(courseId)}/modules/order`, 'PUT', { ids }); await reload();
      };
      const moduleUp = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Subir módulo', 'aria-label': `Mover módulo ${module.title} para cima` });
      const moduleDown = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Descer módulo', 'aria-label': `Mover módulo ${module.title} para baixo` });
      moduleUp.addEventListener('click', () => void moveModule(-1)); moduleDown.addEventListener('click', () => void moveModule(1));
      const addLesson = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Adicionar aula' });
      addLesson.addEventListener('click', async () => { const title = window.prompt('Nome da aula'); if (title?.trim()) { await save(`/api/academy/modules/${encodeURIComponent(module.id)}/lessons`, 'POST', { title: title.trim(), description: '', order: (module.lessons || []).length, active: false, media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }); await reload(); } });
      const lessons = element('ol', { className: 'academy-manager-list' }, (module.lessons || []).map(lessonRow));
      list.append(element('article', { className: 'academy-module-editor' }, [element('div', { className: 'academy-manager-row' }, [heading, active, saveModule, moduleUp, moduleDown, addLesson]), lessons]));
    }
    panel.append(list);
  }
  async function load() {
    const token = ++loadToken;
    loadController?.abort(); loadController = new AbortController();
    const abort = () => loadController.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const loaded = await request.fetchAPI(`/api/academy/${encodeURIComponent(courseId)}?all=true`, { signal: loadController.signal });
      if (!disposed && token === loadToken) { course = { ...(loaded.course || loaded), modules: loaded.modules || loaded.course?.modules || [] }; render(); }
    } catch (error) { if (!disposed && token === loadToken && error?.name !== 'AbortError') feedback.textContent = `Não foi possível carregar o currículo: ${error?.message || 'erro desconhecido'}`; }
    finally { controller.signal.removeEventListener('abort', abort); }
  }
  void load();
  page.beforeLeave(() => !saving && (!dirty || window.confirm('Há alterações do currículo que ainda não foram salvas. Sair mesmo assim?')));
  return { isDirty: () => dirty || saving, dispose() { disposed = true; loadToken += 1; loadController?.abort(); controller.abort(); panel.remove(); } };
}
