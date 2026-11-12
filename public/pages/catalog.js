import { el, button, link, field, errorText } from './dom.js';
import { canPages, newId } from './model.js';
import { renderDocument } from './renderer.js';
import { openPagesDialog } from './dialog.js';

export async function catalog({ root, page, api, params, navigate }) {
  const management = params.get('manage') === '1';
  if (management && !canPages(page.user, 'editPages') && !canPages(page.user, 'publishPages')) throw Object.assign(new Error('Sem acesso'), { status: 403 });
  const offset = /^\d+$/.test(params.get('offset') || '') ? Number(params.get('offset')) : 0;
  const q = el('input', { type: 'search', value: params.get('q') || '', maxlength: 200 });
  const tag = el('input', { value: params.get('tag') || '', maxlength: 40 });
  const actions = el('div', { className: 'pages-actions' });
  if (canPages(page.user, 'editPages') || canPages(page.user, 'publishPages')) actions.append(link(management ? 'Ver publicadas' : 'Gerenciar Pages', `./pages.html${management ? '' : '?manage=1'}`));
  const available = management && canPages(page.user, 'editPages') ? await api.templates() : [];
  if (!page.active) return;
  const createKeys = new Map(); let creating = false;
  const templateSelect = el('select', { 'aria-label': 'Modelo da página' });
  available.forEach(template => templateSelect.append(el('option', { value: template.id, text: template.name })));
  if (available.length) actions.append(field('Modelo', templateSelect));
  if (management && canPages(page.user, 'editPages')) actions.append(button('Criar comunicado', () => {
    const template = available.find(item => item.id === templateSelect.value); if (!template) return;
    if (!createKeys.has(template.id)) createKeys.set(template.id, newId());
    const payload = { template_id: template.id, client_mutation_id: createKeys.get(template.id) };
    openPagesDialog({ page, title: `Criar ${template.name}`, confirmText: 'Criar rascunho',
      content: el('p', { text: template.description }),
      action: async () => {
        if (creating) return; creating = true;
        try { const ack = await api.create(payload);
          createKeys.delete(template.id); if (page.active) {
            const destination = link('Abrir editor', `./page-editor.html?id=${encodeURIComponent(ack.id)}`);
            destination.hidden = true; root.append(destination); destination.click(); destination.remove();
          }
        } catch (error) { throw new Error(errorText(error)); } finally { creating = false; }
      } });
  }, { className: 'btn btn-primary' }));
  const form = el('form', { className: 'pages-filters', onSubmit: event => {
    event.preventDefault(); navigate({ ...(management ? { manage: '1' } : {}), q: q.value, tag: tag.value });
  } }, field('Buscar por título', q), field('Tag', tag), el('button', { type: 'submit', className: 'btn btn-ghost', text: 'Buscar' }));
  const list = el('div', { className: 'pages-catalog' }), status = el('p', { role: 'status', text: 'Carregando Pages…' });
  root.replaceChildren(el('div', { className: 'pages-heading' }, el('h1', { text: management ? 'Gerenciar Pages' : 'Pages' }), actions), form, status, list);
  const result = await api.list({ limit: '20', offset: String(offset), q: params.get('q') || '', tag: params.get('tag') || '' }, management);
  if (!page.active) return;
  status.textContent = `${result.total} ${result.total === 1 ? 'página' : 'páginas'}`;
  if (!result.data.length) list.append(el('p', { text: 'Nenhuma página encontrada.' }));
  for (const item of result.data) {
    const destination = management ? `./page-editor.html?id=${encodeURIComponent(item.id)}` : `./pages.html?id=${encodeURIComponent(item.id)}`;
    list.append(el('article', { className: 'pages-catalog-item' }, el('h2', {}, link(item.title || 'Sem título', destination)),
      el('p', { text: item.summary || '' }), el('p', { className: 'pages-item-meta', text: item.archived_at ? 'Arquivada' : item.published_at ? 'Publicada' : 'Rascunho' }),
      ...(item.tags?.length ? [el('p', { className: 'pages-tags', text: item.tags.join(' · ') })] : [])));
  }
  const pager = el('nav', { className: 'pages-actions', 'aria-label': 'Paginação de Pages' });
  const change = next => navigate({ ...(management ? { manage: '1' } : {}), q: q.value, tag: tag.value, offset: String(next) });
  if (offset > 0) pager.append(button('Anterior', () => change(Math.max(0, offset - 20))));
  if (offset + 20 < result.total) pager.append(button('Próxima', () => change(offset + 20)));
  root.append(pager);
}
export async function readPage({ root, page, api, params }) {
  const id = params.get('id'), preview = params.get('preview') === '1';
  const dto = preview ? await api.preview(id, params.get('revision_id')) : await api.read(id);
  if (!page.active) return;
  const host = el('div', { className: 'pages-preview-frame' });
  const actions = el('div', { className: 'pages-actions' }, link('Voltar às Pages', `./pages.html${preview ? '?manage=1' : ''}`));
  if (preview) actions.append(el('p', { role: 'status', text: 'Prévia privada. Esta revisão não é uma publicação.' }));
  root.replaceChildren(actions, host);
  page.cleanup(renderDocument({ host, document: dto.document, api, pageId: dto.id, revisionId: preview ? dto.revision_id : null }));
}
