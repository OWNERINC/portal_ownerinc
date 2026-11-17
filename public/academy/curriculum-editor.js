import { fetchAPI, fetchAPIPage } from '../js/auth.js';
import { element } from '../js/ui.js';

function mediaInput(value) {
  const url = value.trim();
  let hostname;
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { /* The API validates invalid URLs. */ }
  const youtube = ['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(hostname);
  return { type: youtube ? 'youtube' : 'file', url };
}

export function createCurriculumEditor({ root, page, courseId, initialCourse = null, onSaved = () => {}, registerGuard = true }) {
  const request = page.bindAPI({ fetchAPI, fetchAPIPage });
  let saving = false, locked = false, disposed = false, course = initialCourse;
  const controller = new AbortController();
  let loadController = null, loadToken = 0;
  // Only edited fields are drafts. Authoritative order/media metadata always comes from the API.
  const drafts = new Map();
  const newLessons = new Map();
  const panel = element('section', { className: 'academy-curriculum-editor', 'aria-live': 'polite' });
  root.append(panel);
  const feedback = element('p', { className: 'academy-manager-feedback', role: 'alert' });
  panel.append(element('h2', { text: 'Módulos e aulas' }), feedback);
  const isDirty = () => drafts.size > 0 || [...newLessons.values()].some(draft => draft.title || draft.url);

  function track(key, controls) {
    const capture = () => {
      if (!saving && !locked) drafts.set(key, Object.fromEntries(Object.entries(controls).map(([name, control]) =>
        [name, name === 'active' ? control.checked : control.value])));
    };
    for (const [name, control] of Object.entries(controls)) {
      if (drafts.has(key)) {
        if (name === 'active') control.checked = drafts.get(key)[name];
        else control.value = drafts.get(key)[name];
      }
      control.addEventListener('input', capture);
      control.addEventListener('change', capture);
    }
  }

  async function save(endpoint, method, body, { key, createdIn, apply = () => {}, localFeedback = feedback } = {}) {
    if (saving || locked || disposed) return null;
    saving = true;
    feedback.textContent = ''; localFeedback.textContent = '';
    panel.setAttribute('aria-busy', 'true');
    const controls = [...panel.querySelectorAll('input, button')].map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    try {
      const result = await request.fetchAPI(endpoint, { method, body: JSON.stringify(body), signal: controller.signal });
      if (disposed) return null;
      apply(result);
      if (key) drafts.delete(key);
      if (createdIn) newLessons.delete(createdIn);
      // Reconcile the committed ACK first. A failed GET must not revive old fields/order.
      render();
      await load();
      if (!disposed) onSaved(result);
      return result;
    } catch (error) {
      if (!disposed && error?.name !== 'AbortError') localFeedback.textContent = `Não foi possível salvar: ${error?.message || 'erro desconhecido'}`;
      return null;
    } finally {
      saving = false;
      if (!disposed) {
        controls.forEach(([control, disabled]) => { control.disabled = disabled; });
        panel.querySelectorAll('input, button').forEach(control => { control.disabled = locked; });
        panel.removeAttribute('aria-busy');
      }
    }
  }

  async function move(items, id, delta, endpoint) {
    if (saving || locked) return;
    const ids = [...items].sort((a, b) => a.order - b.order).map(item => item.id);
    const index = ids.indexOf(id), next = index + delta;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    await save(endpoint, 'PUT', { ids }, { apply: rows => {
      for (const row of rows) {
        const item = items.find(item => item.id === row.id);
        if (item) Object.assign(item, row);
      }
    } });
  }

  function lessonRow(lesson, module) {
    const key = `lesson:${lesson.id}`;
    const title = element('input', { className: 'academy-manager-input', value: lesson.title, maxlength: '200', 'aria-label': `Título da aula ${lesson.title}` });
    const media = element('input', { type: 'url', className: 'academy-manager-input', value: lesson.media_type === 'youtube' ? `https://www.youtube.com/watch?v=${lesson.youtube_video_id}` : lesson.media_url || '', maxlength: '2048', 'aria-label': `Vídeo da aula ${lesson.title}` });
    const active = element('input', { type: 'checkbox', checked: lesson.active, 'aria-label': `Aula ativa ${lesson.title}` });
    track(key, { title, media, active });
    const saveButton = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Salvar aula' });
    saveButton.addEventListener('click', () => void save(`/api/academy/lessons/${encodeURIComponent(lesson.id)}`, 'PUT', {
      title: title.value.trim(), description: lesson.description || '', active: active.checked, media: mediaInput(media.value),
    }, { key, apply: result => Object.assign(lesson, result) }));
    const up = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Subir', 'aria-label': `Mover aula ${lesson.title} para cima` });
    const down = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Descer', 'aria-label': `Mover aula ${lesson.title} para baixo` });
    const reorder = delta => move(module.lessons || [], lesson.id, delta, `/api/academy/modules/${encodeURIComponent(module.id)}/lessons/order`);
    up.addEventListener('click', () => void reorder(-1)); down.addEventListener('click', () => void reorder(1));
    return element('li', { className: 'academy-manager-item' }, [title, media, active, saveButton, up, down]);
  }

  function lessonForm(module, addButton) {
    const draft = newLessons.get(module.id);
    const form = element('form', { className: 'academy-new-lesson' });
    const titleId = `academy-new-lesson-title-${module.id}`, urlId = `academy-new-lesson-url-${module.id}`;
    const title = element('input', { id: titleId, className: 'academy-manager-input', required: true, maxlength: '200', value: draft.title });
    const url = element('input', { id: urlId, className: 'academy-manager-input', type: 'url', required: true, maxlength: '2048', value: draft.url });
    const localFeedback = element('p', { className: 'academy-manager-feedback', role: 'alert' });
    const capture = () => { if (!saving && !locked) { draft.title = title.value; draft.url = url.value; } };
    for (const control of [title, url]) { control.addEventListener('input', capture); control.addEventListener('change', capture); }
    const cancel = element('button', { className: 'academy-button academy-button-secondary', type: 'button', text: 'Cancelar' });
    cancel.addEventListener('click', () => {
      if (saving || locked || ((draft.title || draft.url) && !window.confirm('Descartar os dados desta nova aula?'))) return;
      newLessons.delete(module.id); form.remove(); addButton.hidden = false; addButton.focus();
    });
    form.append(
      element('div', { className: 'academy-manager-field' }, [element('label', { for: titleId, text: 'Título da nova aula' }), title]),
      element('div', { className: 'academy-manager-field' }, [element('label', { for: urlId, text: 'URL do vídeo' }), url]),
      element('p', { className: 'academy-manager-help', text: 'Use um vídeo do YouTube ou um arquivo HTTPS MP4/WebM.' }),
      element('div', { className: 'academy-manager-actions' }, [cancel, element('button', { className: 'academy-button', type: 'submit', text: 'Criar aula' })]), localFeedback);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (saving || locked || !form.reportValidity()) return;
      if (!title.value.trim() || !url.value.trim()) { localFeedback.textContent = 'Informe o título e a URL do vídeo.'; return; }
      void save(`/api/academy/modules/${encodeURIComponent(module.id)}/lessons`, 'POST', {
        title: title.value.trim(), description: '', order: Math.max(-1, ...(module.lessons || []).map(lesson => lesson.order)) + 1,
        active: false, media: mediaInput(url.value),
      }, { createdIn: module.id, localFeedback, apply: result => { module.lessons = [...(module.lessons || []), result]; } });
    });
    return form;
  }

  function render() {
    if (!course || disposed) return;
    const list = element('div', { className: 'academy-modules' });
    const addModule = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Adicionar módulo' });
    addModule.addEventListener('click', () => {
      if (saving || locked) return;
      const title = window.prompt('Nome do módulo');
      if (title?.trim()) void save(`/api/academy/${encodeURIComponent(courseId)}/modules`, 'POST', {
        title: title.trim(), order: Math.max(-1, ...(course.modules || []).map(module => module.order)) + 1, active: false,
      }, { apply: result => { course.modules = [...(course.modules || []), { ...result, lessons: [] }]; } });
    });
    list.append(addModule);
    for (const module of [...(course.modules || [])].sort((a, b) => a.order - b.order)) {
      const key = `module:${module.id}`;
      const heading = element('input', { className: 'academy-manager-input', value: module.title, maxlength: '200', 'aria-label': `Título do módulo ${module.title}` });
      const active = element('input', { type: 'checkbox', checked: module.active, 'aria-label': `Módulo ativo ${module.title}` });
      track(key, { title: heading, active });
      const saveModule = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Salvar módulo' });
      saveModule.addEventListener('click', () => void save(`/api/academy/modules/${encodeURIComponent(module.id)}`, 'PUT', {
        title: heading.value.trim(), active: active.checked,
      }, { key, apply: result => Object.assign(module, result) }));
      const reorder = delta => move(course.modules || [], module.id, delta, `/api/academy/${encodeURIComponent(courseId)}/modules/order`);
      const moduleUp = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Subir módulo', 'aria-label': `Mover módulo ${module.title} para cima` });
      const moduleDown = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Descer módulo', 'aria-label': `Mover módulo ${module.title} para baixo` });
      moduleUp.addEventListener('click', () => void reorder(-1)); moduleDown.addEventListener('click', () => void reorder(1));
      const addLesson = element('button', { className: 'academy-button academy-button-small', type: 'button', text: 'Adicionar aula' });
      const lessons = element('ol', { className: 'academy-manager-list' }, [...(module.lessons || [])].sort((a, b) => a.order - b.order).map(lesson => lessonRow(lesson, module)));
      const article = element('article', { className: 'academy-module-editor' }, [element('div', { className: 'academy-manager-row' }, [heading, active, saveModule, moduleUp, moduleDown, addLesson]), lessons]);
      addLesson.addEventListener('click', () => {
        if (saving || locked || newLessons.has(module.id)) return;
        newLessons.set(module.id, { title: '', url: '' }); addLesson.hidden = true;
        const form = lessonForm(module, addLesson); article.append(form); form.querySelector('input').focus();
      });
      if (newLessons.has(module.id)) { addLesson.hidden = true; article.append(lessonForm(module, addLesson)); }
      list.append(article);
    }
    panel.querySelector('.academy-modules')?.remove();
    panel.append(list);
    if (saving || locked) list.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
  }

  async function load() {
    const token = ++loadToken;
    loadController?.abort();
    const current = new AbortController(); loadController = current;
    const abort = () => current.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const loaded = await request.fetchAPI(`/api/academy/${encodeURIComponent(courseId)}?all=true`, { signal: current.signal });
      if (!disposed && token === loadToken) { course = { ...(loaded.course || loaded), modules: loaded.modules || loaded.course?.modules || [] }; render(); return true; }
    } catch (error) { if (!disposed && token === loadToken && error?.name !== 'AbortError') feedback.textContent = `Não foi possível carregar o currículo: ${error?.message || 'erro desconhecido'}`; }
    finally { controller.signal.removeEventListener('abort', abort); }
    return false;
  }
  if (initialCourse) render(); else void load();
  if (registerGuard) page.beforeLeave(() => disposed || (!saving && !locked && (!isDirty() || window.confirm('Há alterações do currículo que ainda não foram salvas. Sair mesmo assim?'))));
  return {
    isDirty, isSaving: () => saving || locked,
    setLocked(value) { locked = value; panel.querySelectorAll('input, button').forEach(control => { control.disabled = saving || locked; }); },
    dispose() { disposed = true; loadToken += 1; loadController?.abort(); controller.abort(); panel.remove(); },
  };
}
