import { can, fetchAPI, fetchAPIPage } from '../js/auth.js';
import { element } from '../js/ui.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function input(label, id, type = 'text', value = '', attrs = {}) {
  const control = element(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', { id, className: 'academy-manager-input', ...attrs });
  if (type === 'textarea') control.value = value || '';
  else if (type !== 'select') control.value = value ?? '';
  const group = element('div', { className: 'academy-manager-field' }, [element('label', { htmlFor: id, text: label }), control]);
  return { group, control };
}

function selectedIds(select) { return [...select.selectedOptions].map(option => option.value).filter(id => UUID.test(id)); }

export function createCourseEditor({ root, page, course = null, onSaved = () => {} }) {
  const request = page.bindAPI({ fetchAPI, fetchAPIPage });
  let dirty = false;
  let saving = false;
  let disposed = false;
  let jobTitleLoadFailed = false;
  const form = element('form', { className: 'academy-manager-form', novalidate: '' });
  const fields = {};
  const add = (name, type, value, attrs) => { const result = input(name, `academy-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`, type, value, attrs); fields[name] = result.control; form.append(result.group); return result.control; };
  add('Título', 'text', course?.title, { required: '', maxlength: '200' });
  add('Categoria', 'text', course?.category, { maxlength: '100' });
  add('Descrição', 'textarea', course?.description, { maxlength: '5000', rows: '4' });
  const delivery = add('Entrega', 'select', course?.delivery_mode || 'external');
  delivery.append(element('option', { value: 'external', text: 'Curso externo' }), element('option', { value: 'internal', text: 'Curso interno' }));
  const audience = add('Público', 'select', course?.audience || 'all');
  audience.append(element('option', { value: 'all', text: 'Todos' }), element('option', { value: 'job_titles', text: 'Cargos selecionados' }));
  add('Grupo visual', 'select', course?.learning_group || 'initial').append(element('option', { value: 'initial', text: 'Formação inicial' }), element('option', { value: 'role', text: 'Formação por cargo' }));
  add('Ícone', 'select', course?.icon_key || 'icon-01').append(...Array.from({ length: 6 }, (_, index) => element('option', { value: `icon-0${index + 1}`, text: `Ícone ${index + 1}` })));
  add('Capa (asset ID, opcional)', 'text', course?.cover_asset_id, { maxlength: '36', placeholder: 'UUID do asset CMS' });
  add('Instrutor', 'text', course?.instructor_name, { maxlength: '120' });
  add('Ordem', 'number', course?.order ?? 0, { min: '-100000', max: '100000' });
  add('URL externa', 'url', course?.url, { maxlength: '2048' });
  const active = add('Disponível', 'select', course?.active ? 'true' : 'false');
  active.append(element('option', { value: 'false', text: 'Rascunho / indisponível' }), element('option', { value: 'true', text: 'Disponibilizar' }));
  const titles = add('Cargos elegíveis', 'select', '', { multiple: '', size: '7', 'aria-describedby': 'academy-job-title-help' });
  const help = element('p', { id: 'academy-job-title-help', className: 'academy-manager-help', role: 'status', text: 'Carregando cargos…' });
  form.append(help);
  const feedback = element('p', { className: 'academy-manager-feedback', role: 'alert', 'aria-live': 'polite' });
  const save = element('button', { className: 'academy-button', type: 'submit', text: course ? 'Salvar curso' : 'Criar curso' });
  const cancel = element('button', { className: 'academy-button academy-button-secondary', type: 'button', text: 'Cancelar' });
  form.append(element('div', { className: 'academy-manager-actions' }, [cancel, save]), feedback);
  root.replaceChildren(element('h2', { text: course ? 'Editar curso' : 'Novo curso' }), form);

  function markDirty() { if (!saving) { dirty = true; page.toast?.('Há alterações não salvas.'); } }
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  audience.addEventListener('change', () => { titles.disabled = audience.value !== 'job_titles'; });
  delivery.addEventListener('change', () => { fields['URL externa'].required = delivery.value === 'external'; });
  titles.disabled = audience.value !== 'job_titles';
  fields['URL externa'].required = delivery.value === 'external';

  async function loadTitles() {
    try {
      let offset = 0, total = 1, all = [];
      while (offset < total) {
        const result = await request.fetchAPIPage(`/api/job-titles?all=true&limit=100&offset=${offset}`);
        total = result.total ?? result.data.length; all = all.concat(result.data || []);
        if (!(result.data || []).length) break;
        offset += result.data.length;
      }
      if (disposed) return;
      titles.replaceChildren(...all.map(title => element('option', { value: title.id, text: `${title.name}${title.active ? '' : ' (inativo)'}`, selected: (course?.allowed_job_title_ids || []).some(id => id.toLowerCase() === title.id.toLowerCase()) })));
      help.textContent = `${all.length} cargos carregados. Cargos inativos permanecem visíveis, mas não concedem acesso.`;
      titles.disabled = audience.value !== 'job_titles';
    } catch {
      jobTitleLoadFailed = true;
      help.textContent = 'Não foi possível carregar todos os cargos. O seletor não está disponível.';
      titles.replaceChildren(); titles.disabled = true;
    }
  }
  void loadTitles();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || jobTitleLoadFailed || !form.reportValidity()) return;
    if (audience.value === 'job_titles' && !selectedIds(titles).length) { feedback.textContent = 'Selecione ao menos um cargo para um curso restrito.'; return; }
    saving = true; save.disabled = true; form.setAttribute('aria-busy', 'true'); feedback.textContent = '';
    const body = {
      title: fields.Título.value.trim(), category: fields.Categoria.value.trim(), description: fields.Descrição.value.trim(),
      delivery_mode: delivery.value, audience: audience.value, learning_group: fields['Grupo visual'].value, icon_key: fields.Ícone.value,
      instructor_name: fields.Instrutor.value.trim(), order: Number(fields.Ordem.value), active: active.value === 'true',
      url: delivery.value === 'internal' ? null : fields['URL externa'].value.trim(), allowed_job_title_ids: selectedIds(titles),
    };
    try {
      const saved = await request.fetchAPI(course ? `/api/academy/${encodeURIComponent(course.id)}` : '/api/academy', { method: course ? 'PUT' : 'POST', body: JSON.stringify(body) });
      dirty = false; onSaved(saved);
    } catch (error) {
      feedback.textContent = error.status === 409 ? 'O curso foi alterado por outra sessão. Recarregue e tente novamente.' : `Não foi possível salvar o curso: ${error.message}`;
    } finally { saving = false; save.disabled = false; form.removeAttribute('aria-busy'); }
  });
  cancel.addEventListener('click', () => onSaved(null));
  page.beforeLeave(() => !saving && (!dirty || window.confirm('Há alterações do curso que ainda não foram salvas. Sair mesmo assim?')));
  return { isDirty: () => dirty || saving, dispose() { disposed = true; form.replaceChildren(); } };
}
