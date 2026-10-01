import { fetchAPI, fetchAPIPage } from '../auth.js';
import { element, protectForm } from '../ui.js';

const ENDPOINT = '/api/cms/owner-news/polls';
const labels = { draft: 'Rascunho', open: 'Aberta', closed: 'Encerrada' };
const limits = { title: 80, question: 240, description: 600, closing: 200 };

export function mountNewsPollManager({ root, page, onDirty = () => {} }) {
  root.classList.add('cms-poll-manager');
  const api = page.bindAPI({ fetchAPI, fetchAPIPage });
  const controller = new AbortController();
  let disposed = false, busy = false, writing = false, allowed = false, conflict = false;
  let rows = [], total = 0, offset = 0, selected = null, editing = false, current = null;
  let form, fields = {}, options = [], markClean, message = 'Carregando enquetes…';
  let listeners = [], optionListeners = [], controls = {}, status, optionRoot;
  const active = () => !disposed && page.active;
  const payload = () => ({ ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()])), options: options.map(input => input.value.trim()) });
  const dirty = () => !!form && !!markClean?.isDirty();
  const valid = () => {
    const value = payload();
    const keys = value.options.map(label => label.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' '));
    return value.title && value.question && Object.entries(limits).every(([key, max]) => value[key].length <= max)
      && options.length >= 2 && options.length <= 6 && value.options.every(label => label && label.length <= 100 && !/[\r\n]/.test(label))
      && new Set(keys).size === keys.length;
  };
  function listen(node, type, callback, bucket = listeners) {
    const handler = event => { if (active()) callback(event); };
    node.addEventListener(type, handler);
    bucket.push(() => node.removeEventListener(type, handler));
  }
  function button(text, callback, key, bucket = listeners) {
    const node = element('button', { type: 'button', className: 'btn btn-ghost', text });
    listen(node, 'click', callback, bucket);
    if (key) controls[key] = node;
    return node;
  }
  function canLeave() {
    if (writing) { page.toast('Aguarde a operação do CMS terminar.'); return false; }
    return !dirty() || window.confirm('Há alterações do CMS que ainda não foram salvas. Sair mesmo assim?');
  }
  function sync() {
    if (!active()) return;
    root.querySelectorAll('button, input, textarea').forEach(node => { node.disabled = busy; });
    if (controls.save) controls.save.disabled = busy || conflict || !valid();
    if (controls.publish) controls.publish.disabled = busy || conflict || !selected?.id || dirty() || !valid();
    if (controls.close) controls.close.disabled = busy || conflict;
    if (controls.previous) controls.previous.disabled = busy || offset === 0;
    if (controls.next) controls.next.disabled = busy || offset + 20 >= total;
    if (controls.add) controls.add.disabled = busy || options.length >= 6;
    optionRoot?.querySelectorAll('button').forEach(node => { node.disabled = busy || node.dataset.unavailable === 'true'; });
    status.textContent = message;
    onDirty(dirty(), writing);
  }
  function select(next, copy = false) {
    if (busy || !canLeave()) return;
    selected = copy ? null : next;
    editing = copy || next?.status === 'draft' || !next;
    conflict = false; current = null; message = '';
    render(copy ? next : null);
  }
  function renderOptions(values) {
    optionListeners.forEach(remove => remove()); optionListeners = [];
    options = [];
    optionRoot.replaceChildren();
    values.forEach((value, index) => {
      const input = element('input', { name: 'option', className: 'form-input', type: 'text', maxlength: '100', required: '' });
      input.value = value; options.push(input);
      listen(input, 'input', sync, optionListeners);
      const row = element('div', { className: 'cms-poll-option' }, [element('label', { className: 'cms-field' }, [element('span', { text: `Opção ${index + 1}` }), input])]);
      const actions = element('div', { className: 'cms-form-actions' });
      for (const [text, delta] of [['Subir', -1], ['Descer', 1], ['Remover', 0]]) {
        const control = button(text, () => {
          if (busy || control.dataset.unavailable === 'true') return;
          const next = options.map(item => item.value);
          if (delta) [next[index], next[index + delta]] = [next[index + delta], next[index]];
          else next.splice(index, 1);
          renderOptions(next); sync();
          options[Math.min(index, options.length - 1)]?.focus();
        }, null, optionListeners);
        control.setAttribute('aria-label', `${text} opção ${index + 1}`);
        control.dataset.unavailable = String(delta ? index + delta < 0 || index + delta >= values.length : values.length <= 2);
        actions.append(control);
      }
      row.append(actions); optionRoot.append(row);
    });
  }
  function render(copy = null) {
    listeners.forEach(remove => remove()); listeners = [];
    optionListeners.forEach(remove => remove()); optionListeners = [];
    controls = {}; fields = {}; options = []; form = null; markClean = null; optionRoot = null;
    status = element('p', { role: 'status', 'aria-live': 'polite' });
    root.replaceChildren(element('h2', { text: 'Enquetes' }));
    if (!allowed) { root.append(status); sync(); return; }
    root.append(button('Nova enquete', () => select(null)));
    const list = element('ul', { className: 'cms-poll-list', 'aria-label': 'Enquetes salvas' });
    rows.forEach(poll => list.append(element('li', {}, [button(`${poll.title} · ${labels[poll.status]}`, () => select(poll))])));
    root.append(list, element('div', { className: 'cms-form-actions' }, [
      button('Anterior', () => void load(offset - 20), 'previous'),
      element('span', { text: `${total} enquetes · Página ${Math.floor(offset / 20) + 1}` }),
      button('Próxima', () => void load(offset + 20), 'next'),
      button('Atualizar lista', () => void load(offset)),
    ]));
    if (editing) {
      const content = copy || selected;
      form = element('form', { className: 'cms-poll-form' });
      for (const [name, label] of [['title', 'Título'], ['question', 'Pergunta'], ['description', 'Descrição'], ['closing', 'Mensagem de encerramento']]) {
        const input = element(name === 'description' ? 'textarea' : 'input', { name, className: 'form-input', maxlength: String(limits[name]), ...(name === 'title' || name === 'question' ? { required: '' } : {}) });
        input.value = content?.[name] || ''; fields[name] = input;
        listen(input, 'input', sync);
        form.append(element('label', { className: 'cms-field' }, [element('span', { className: 'form-label', text: label }), input]));
      }
      optionRoot = element('div'); renderOptions(content?.options.map(option => option.label) || ['', '']);
      const add = button('Adicionar opção', () => { if (!busy && options.length < 6) { renderOptions([...options.map(input => input.value), '']); sync(); options.at(-1).focus(); } }, 'add');
      const save = button('Salvar rascunho', () => {}, 'save'); save.type = 'submit';
      form.append(optionRoot, add, element('p', { className: 'form-help', text: 'Use de 2 a 6 opções distintas. Publicar congela a pergunta e as opções.' }),
        element('div', { className: 'cms-form-actions' }, [save, button('Publicar enquete', () => void mutate('publish'), 'publish')]));
      listen(form, 'submit', event => { event.preventDefault(); void mutate('draft'); });
      root.append(form);
      markClean = protectForm(form, null, { managed: true, serialize: () => JSON.stringify(payload()) });
      // A copied poll is an unsaved form even though its initial values are valid.
      if (copy) { const clean = markClean; markClean = Object.assign(() => clean(), { isDirty: () => !selected || clean.isDirty() }); }
    } else if (selected) {
      root.append(element('h3', { text: selected.question }), element('p', { text: selected.description }),
        element('p', { text: `${labels[selected.status]} · ${selected.total_votes} votos` }));
      const results = element('ul');
      selected.options.forEach(option => results.append(element('li', { text: `${option.label}: ${option.votes} votos (${option.percentage}%)` })));
      root.append(results, element('p', { text: selected.closing }));
      if (selected.status === 'open') root.append(button('Encerrar enquete', () => void mutate('close'), 'close'));
      else root.append(button('Criar nova enquete', () => select(selected, true)));
    }
    root.append(button('Recarregar versão atual', () => void reconcile(), 'reload'), status);
    controls.reload.hidden = !conflict;
    sync();
  }
  function denied() {
    allowed = false; editing = false; selected = null; message = 'Você não tem permissão para gerenciar enquetes.'; render();
  }
  async function load(nextOffset = offset) {
    if (!active() || busy || !canLeave()) return;
    busy = true; message = 'Carregando enquetes…'; sync();
    try {
      const result = await api.fetchAPIPage(`${ENDPOINT}?limit=20&offset=${nextOffset}`, { signal: controller.signal });
      if (!active()) return;
      rows = result.data; total = result.total; offset = nextOffset; allowed = true;
      selected = null; editing = false; conflict = false; message = rows.length ? '' : 'Nenhuma enquete cadastrada.'; render();
    } catch (error) {
      if (!active()) return;
      if (error?.status === 403) denied();
      else { message = 'Não foi possível carregar a lista. Tente novamente.'; if (!allowed) { root.append(button('Tentar novamente', () => void load(nextOffset))); } }
    } finally { if (active()) { busy = false; sync(); } }
  }
  async function reconcile() {
    if (!active() || busy || !canLeave() || !selected) return;
    busy = true; message = 'Carregando versão atual…'; sync();
    try {
      // The admin API has a paginated list, but no single-draft GET. Find the
      // authoritative DTO without losing regenerated option IDs or version.
      let found = null;
      for (let start = 0; !found; start += 20) {
        const result = await api.fetchAPIPage(`${ENDPOINT}?limit=20&offset=${start}`, { signal: controller.signal });
        if (!active()) return;
        found = result.data.find(poll => poll.id === selected.id);
        if (start + 20 >= result.total) break;
      }
      if (!found) throw new Error('missing');
      selected = found; editing = found.status === 'draft'; conflict = false; current = null;
      rows = rows.map(poll => poll.id === found.id ? found : poll);
      message = 'Versão atual carregada.'; render();
    } catch (error) {
      if (!active()) return;
      if (error?.status === 403) denied();
      else message = 'Não foi possível recarregar. Seus valores continuam na tela. Tente novamente.';
    } finally { if (active()) { busy = false; sync(); } }
  }
  async function mutate(action) {
    if (!active() || busy || !allowed || conflict) return;
    if (action === 'draft' && (!form || !valid() || !form.reportValidity())) return;
    if (action === 'publish' && (!selected || selected.status !== 'draft' || dirty() || !valid())) return;
    if (action === 'close' && selected?.status !== 'open') return;
    const creating = action === 'draft' && !selected;
    const body = { ...(action === 'draft' ? payload() : {}), ...(!creating ? { expected_version: selected.version } : {}) };
    busy = true; writing = true; message = 'Salvando…'; sync();
    try {
      const next = await api.fetchAPI(creating ? ENDPOINT : `${ENDPOINT}/${selected.id}/${action}`, {
        method: action === 'draft' && !creating ? 'PUT' : 'POST', body: JSON.stringify(body), signal: controller.signal,
      });
      if (!active()) return;
      selected = next; editing = next.status === 'draft';
      if (creating) { rows = offset === 0 ? [next, ...rows].slice(0, 20) : rows; total++; }
      else rows = rows.map(poll => poll.id === next.id ? next : poll);
      message = action === 'draft' ? 'Rascunho salvo' : action === 'publish' ? 'Enquete publicada' : 'Enquete encerrada';
      render();
    } catch (error) {
      if (!active()) return;
      if (error?.status === 403) { denied(); return; }
      if (error?.reason === 'active_poll_exists') {
        message = 'Já existe uma enquete aberta.';
        try {
          const result = await api.fetchAPI('/api/announcements/polls/current', { signal: controller.signal });
          if (!active()) return;
          current = result.poll;
          if (current?.status === 'open') {
            root.append(button(`Ver enquete aberta: ${current.question}`, () => select(current)));
          }
        } catch { if (active()) message += ' Não foi possível carregar a enquete atual. Tente publicar novamente.'; }
      } else {
        conflict = error?.status === 409;
        message = conflict ? 'A enquete mudou em outra sessão. Seus valores continuam na tela. Recarregue a versão atual para continuar.'
          : 'Não foi possível concluir. Revise os campos e tente novamente; seus valores continuam na tela.';
        if (controls.reload) controls.reload.hidden = !conflict;
      }
    } finally { if (active()) { busy = false; writing = false; sync(); } }
  }
  render(); void load();
  return {
    canLeave,
    dispose() {
      if (disposed) return;
      disposed = true; controller.abort(); listeners.forEach(remove => remove()); listeners = [];
      optionListeners.forEach(remove => remove()); optionListeners = [];
      root.classList.remove('cms-poll-manager');
      root.replaceChildren(); onDirty(false, false);
    },
  };
}
