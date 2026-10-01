import { fetchAPI } from '../auth.js';
import { element } from '../ui.js';

export function mountNewsHomeEditor({ root, page, onDirty = () => {} }) {
  const request = page.bindAPI({ fetchAPI }).fetchAPI;
  const controller = new AbortController();
  const listeners = [];
  let disposed = false, generation = 0, dirty = false, busy = false, state = null, conflict = false;
  const active = () => !disposed && page.active;
  const listen = (node, type, callback) => {
    const handler = page.listen(node, type, event => { if (active()) callback(event); });
    listeners.push(() => node.removeEventListener(type, handler));
  };
  const form = element('form', { className: 'cms-home-form' });
  const fields = {};
  form.append(element('h2', { text: 'Página inicial da Owner News' }));
  for (const [name, label, max] of [['eyebrow', 'Chamada', 80], ['headline', 'Título de abertura', 160], ['summary', 'Resumo', 600]]) {
    const field = element(name === 'headline' ? 'textarea' : 'input', { name, className: 'form-input', maxlength: String(max), required: '', ...(name === 'headline' ? { rows: '3' } : { type: 'text' }) });
    fields[name] = field;
    listen(field, 'input', () => { dirty = true; sync(); });
    form.append(element('label', { className: 'cms-field' }, [element('span', { className: 'form-label', text: label }), field]));
  }
  const status = element('p', { role: 'status', 'aria-live': 'polite' });
  const save = element('button', { type: 'submit', className: 'btn btn-primary', text: 'Salvar rascunho' });
  const publish = element('button', { type: 'button', className: 'btn btn-ghost', text: 'Publicar' });
  const reload = element('button', { type: 'button', className: 'btn btn-ghost', text: 'Recarregar versão atual', hidden: '' });
  form.append(element('p', { className: 'form-help', text: 'Salvar rascunho guarda a abertura. Publicar disponibiliza o rascunho salvo aos leitores.' }),
    element('div', { className: 'cms-form-actions' }, [save, publish, reload]), status);
  root.replaceChildren(form);
  function sync() {
    save.disabled = busy || !state || conflict;
    publish.disabled = busy || !state?.draft || dirty || conflict;
    reload.disabled = busy;
    Object.values(fields).forEach(field => { field.disabled = busy; });
    onDirty(dirty, busy);
  }
  function showState(next) {
    state = next; dirty = false; conflict = false; reload.hidden = true;
    const content = next.draft || next.published;
    Object.entries(fields).forEach(([name, field]) => { field.value = content?.[name] || ''; });
  }
  async function load() {
    if (!active() || busy) return;
    if (dirty && !window.confirm('Há alterações do CMS que ainda não foram salvas. Sair mesmo assim?')) return;
    const token = ++generation;
    busy = true; sync(); status.textContent = 'Carregando abertura…';
    try {
      const next = await request('/api/cms/owner-news/home', { signal: controller.signal });
      if (!active() || token !== generation) return;
      showState(next); status.textContent = next.draft ? 'Rascunho salvo' : 'Abertura carregada';
    } catch {
      if (active() && token === generation) { status.textContent = 'Não foi possível carregar a abertura. Tente novamente.'; reload.hidden = false; }
    } finally { if (active() && token === generation) { busy = false; sync(); } }
  }
  async function mutate(publishing) {
    if (!active() || busy || !state || conflict || (publishing && (dirty || !state.draft))) return;
    if (!publishing && !form.reportValidity()) return;
    const content = { version: 1, ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value.trim()])) };
    const token = ++generation;
    busy = true; sync(); status.textContent = publishing ? 'Publicando…' : 'Salvando rascunho…';
    try {
      const next = await request(`/api/cms/owner-news/home/${publishing ? 'publish' : 'draft'}`, {
        method: publishing ? 'POST' : 'PUT', signal: controller.signal,
        body: JSON.stringify({ expected_version: state.version, ...(!publishing ? { content } : {}) }),
      });
      if (!active() || token !== generation) return;
      showState(next); status.textContent = publishing ? 'Abertura publicada' : 'Rascunho salvo';
    } catch (error) {
      if (!active() || token !== generation) return;
      conflict = error?.status === 409;
      status.textContent = conflict ? 'A abertura mudou em outra sessão. Seus valores continuam na tela. Recarregue a versão atual para continuar.'
        : 'Não foi possível concluir. Revise os campos e tente novamente; seus valores continuam na tela.';
      reload.hidden = !conflict;
    } finally { if (active() && token === generation) { busy = false; sync(); } }
  }
  listen(form, 'submit', event => { event.preventDefault(); void mutate(false); });
  listen(publish, 'click', () => void mutate(true));
  listen(reload, 'click', () => void load());
  void load();
  return {
    canLeave() {
      if (busy && page.busy) { page.toast('Aguarde a operação do CMS terminar.'); return false; }
      return !dirty || window.confirm('Há alterações do CMS que ainda não foram salvas. Sair mesmo assim?');
    },
    dispose() { if (disposed) return; disposed = true; ++generation; controller.abort(); listeners.forEach(remove => remove()); root.replaceChildren(); onDirty(false, false); },
  };
}
