import { fetchAPI, fetchAPIAsset, fetchAPIPage } from '../js/auth.js';
import { requirePosCards } from './guard.js';

const $ = (id) => document.getElementById(id);
const fieldNames = [...document.querySelectorAll('[data-field]')].map((field) => field.dataset.field);
const defaults = {
  heroTitle: 'Este é um convite', heroEmphasis: 'para viver o seu tempo', heroBrand: 'Owntime',
  greeting: 'Você é nosso convidado para viver uma experiência Owntime Home Club Gramado:',
  stayInfo: 'Hospedagem para xx pessoas\nDe xx/xx a xx/xx\nUnidade: flat/casa | xx hóspedes',
  experienceTitle: 'Sua experiência inclui:',
  experienceBody: 'Hospedagem com acesso aos espaços de lazer de uso comum disponíveis no Club House Owntime.',
  foodInfo: 'Café da manhã para xx pessoas.\nRestaurante Tempo | 7h às 11h',
  consumptionTitle: 'Consumos da hospedagem:',
  consumptionBody: 'Água, energia elétrica, gás e demais consumos relacionados à estadia serão tratados conforme a condição indicada acima.',
  afterStay: 'Como parte da experiência, após a estadia, o presenteado deverá preencher a pesquisa de satisfação pós-estada, compartilhando sua percepção sobre a hospedagem e contribuindo para o aprimoramento contínuo da experiência Owntime.',
  conditions: 'Necessária reserva prévia e sujeita à disponibilidade de datas.\nConsulte as condições de utilização deste convite.',
  contact: 'CENTRAL DE RELACIONAMENTO\n54 3421 9988  |  contato@ownerinc.com.br',
};
let current = { values: { ...defaults }, mediaId: null, mediaUrl: '', editingId: null, name: '' };
let historyRequest = 0;
let historyOffset = 0;
let mediaOperationToken = 0;
let activeMediaPromise = null;
const HISTORY_PAGE_SIZE = 50;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

function setStatus(message, error = false) {
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('is-error', error);
}

function render() {
  const v = current.values;
  const media = current.mediaUrl ? `<img class="hero-image" src="${esc(current.mediaUrl)}" alt="">` : '';
  $('cardCanvas').innerHTML = `<section class="hero">${media}<div class="hero-content"><h2>${esc(v.heroTitle)}<em>${esc(v.heroEmphasis)}</em></h2><div class="hero-brand">${esc(v.heroBrand)}</div></div><div class="gold-rule"></div></section><section class="card-body"><div class="card-copy"><p class="greeting">${esc(v.greeting)}</p><p>${esc(v.stayInfo)}</p><div class="benefit-box"><h3>${esc(v.experienceTitle)}</h3><p>${esc(v.experienceBody)}</p><p>${esc(v.foodInfo)}</p><h3>${esc(v.consumptionTitle)}</h3><p>${esc(v.consumptionBody)}</p></div><p class="closing">${esc(v.afterStay)}</p><p>${esc(v.conditions)}</p></div></section><footer class="card-footer"><div class="contact">${esc(v.contact)}</div><div class="footer-logos"><img class="owntime-logo" src="./cards-pos/assets/owntime-logo-white.webp" alt="Owntime Home Club Gramado"><span class="footer-divider"></span><img class="ownerinc-logo" src="./cards-pos/assets/ownerinc-logo-white.png" alt="Ownerinc"><span class="footer-divider"></span><img class="casa-logo" src="./cards-pos/assets/casa-logo-white.svg" alt="Casa Hotéis"></div></footer>`;
  requestAnimationFrame(fitCardBody);
}

function fitCardBody() {
  const copy = document.querySelector('.card-copy');
  if (!copy) return;
  copy.style.transform = 'none';
  copy.style.width = '100%';
}

function preparePrint() {
  const body = document.querySelector('.card-body');
  const copy = document.querySelector('.card-copy');
  if (!body || !copy) return;
  copy.style.transform = 'none';
  copy.style.width = '100%';
  const scale = Math.min(1, body.clientHeight / copy.scrollHeight);
  if (scale < 1) {
    copy.style.transform = `scale(${scale})`;
    copy.style.width = `${100 / scale}%`;
  }
}

function loadValues(values = defaults) {
  current.values = { ...defaults, ...values };
  for (const name of fieldNames) {
    const field = document.querySelector(`[data-field="${name}"]`);
    if (field) field.value = current.values[name] ?? '';
  }
  render();
}

function replaceMediaUrl(url) {
  if (current.mediaUrl?.startsWith('blob:')) URL.revokeObjectURL(current.mediaUrl);
  current.mediaUrl = url || '';
}

function setMediaBusy(busy) {
  $('uploadButton').disabled = busy;
  $('imageInput').disabled = busy;
  $('saveButton').disabled = busy;
}

async function runMediaOperation(operation) {
  const operationToken = ++mediaOperationToken;
  const promise = operation(operationToken);
  activeMediaPromise = promise;
  setMediaBusy(true);
  try {
    return await promise;
  } catch (error) {
    if (operationToken !== mediaOperationToken) return undefined;
    throw error;
  } finally {
    if (activeMediaPromise === promise) {
      activeMediaPromise = null;
      setMediaBusy(false);
    }
  }
}

async function upload(file) {
  return runMediaOperation(async (operationToken) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Escolha uma imagem PNG, JPEG ou WebP.');
    const dimensions = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(image.src); resolve([image.naturalWidth, image.naturalHeight]); };
      image.onerror = () => { URL.revokeObjectURL(image.src); reject(new Error('Não foi possível ler a imagem.')); };
      image.src = URL.createObjectURL(file);
    });
    if (operationToken !== mediaOperationToken) return;
    if (dimensions.some((value) => value < 500)) throw new Error('A imagem precisa ter pelo menos 500 × 500 px.');
    setStatus('Enviando imagem...');
    const media = await fetchAPI('/api/pos-cards/media', { method: 'POST', headers: { 'content-type': file.type }, body: file });
    if (operationToken !== mediaOperationToken) return;
    const mediaUrl = await fetchAPIAsset(media.url || `/api/pos-cards/media/${media.id}`);
    if (operationToken !== mediaOperationToken) return;
    current.mediaId = media.id;
    replaceMediaUrl(mediaUrl);
    render();
    setStatus('Imagem adicionada ao convite.');
  });
}

async function save() {
  if (activeMediaPromise) return;
  const name = window.prompt('Nome do convite:', current.name || current.values.heroBrand || 'Convite Owntime');
  if (!name?.trim()) return;
  const button = $('saveButton');
  button.disabled = true;
  setStatus('Salvando convite...');
  try {
    const editing = Boolean(current.editingId);
    const saved = await fetchAPI(editing ? `/api/pos-cards/cards/${current.editingId}` : '/api/pos-cards/cards', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), template: 'convite_owntime', values: current.values, mediaId: current.mediaId }),
    });
    current.editingId = saved.id;
    current.name = saved.name || name.trim();
    setStatus('Convite salvo no histórico.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderHistory(cards) {
  $('historyList').innerHTML = cards.map((card) => `<article class="history-item"><div><strong>${esc(card.name)}</strong><small>Atualizado em ${esc(new Date(card.updatedAt).toLocaleDateString('pt-BR'))}</small></div><div class="history-actions"><button type="button" data-edit="${esc(card.id)}">Editar</button><button type="button" data-copy="${esc(card.id)}">Duplicar</button><button type="button" data-delete="${esc(card.id)}">Excluir</button></div></article>`).join('');
  $('historyEmpty').classList.toggle('hidden', cards.length > 0);
}

function renderHistoryPagination(total) {
  const pagination = $('historyPagination');
  pagination.replaceChildren();
  if (total <= HISTORY_PAGE_SIZE) return;
  const pageButton = (label, offset, disabled) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost btn-sm';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', () => { historyOffset = offset; loadHistory(); });
    return button;
  };
  const page = Math.floor(historyOffset / HISTORY_PAGE_SIZE) + 1;
  const pageLabel = document.createElement('span');
  pageLabel.textContent = `Página ${page} de ${Math.ceil(total / HISTORY_PAGE_SIZE)}`;
  pagination.append(
    pageButton('Anterior', historyOffset - HISTORY_PAGE_SIZE, historyOffset === 0),
    pageLabel,
    pageButton('Próxima', historyOffset + HISTORY_PAGE_SIZE, historyOffset + HISTORY_PAGE_SIZE >= total),
  );
}

async function loadHistory() {
  const requestToken = ++historyRequest;
  const empty = $('historyEmpty');
  empty.textContent = 'Carregando convites...';
  empty.classList.remove('hidden');
  try {
    const search = encodeURIComponent($('historySearch').value);
    const result = await fetchAPIPage(`/api/pos-cards/cards?search=${search}&limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`);
    if (requestToken !== historyRequest) return;
    const cards = result.data || [];
    renderHistory(cards);
    renderHistoryPagination(result.total ?? cards.length);
    empty.textContent = 'Nenhum convite salvo ainda.';
    setStatus(cards.length ? `${cards.length} convite(s) encontrado(s).` : 'Nenhum convite salvo ainda.');
  } catch (error) {
    if (requestToken !== historyRequest) return;
    $('historyList').replaceChildren();
    $('historyPagination').replaceChildren();
    empty.textContent = 'Não foi possível carregar o histórico.';
    setStatus(error.message, true);
  }
}

async function editCard(id) {
  setStatus('Carregando convite...');
  try {
    await runMediaOperation(async (operationToken) => {
      const card = await fetchAPI(`/api/pos-cards/cards/${encodeURIComponent(id)}`);
      if (operationToken !== mediaOperationToken) return;
      const mediaUrl = card.mediaId ? await fetchAPIAsset(`/api/pos-cards/media/${card.mediaId}`) : '';
      if (operationToken !== mediaOperationToken) return;
      replaceMediaUrl('');
      current = { ...current, editingId: card.id, mediaId: card.mediaId, name: card.name || '' };
      loadValues(card.values);
      replaceMediaUrl(mediaUrl);
      render();
      showView('editor');
      setStatus('Convite carregado para edição.');
    });
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function duplicateCard(id) {
  setStatus('Duplicando convite...');
  try {
    await fetchAPI(`/api/pos-cards/cards/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
    historyOffset = 0;
    await loadHistory();
    setStatus('Convite duplicado.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function deleteCard(id) {
  if (!window.confirm('Excluir este convite?')) return;
  setStatus('Excluindo convite...');
  try {
    await fetchAPI(`/api/pos-cards/cards/${encodeURIComponent(id)}`, { method: 'DELETE' });
    historyOffset = 0;
    await loadHistory();
    setStatus('Convite excluído.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

function showView(view) {
  document.querySelectorAll('.nav-button').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('editorView').classList.toggle('hidden', view !== 'editor');
  $('historyView').classList.toggle('hidden', view !== 'history');
  if (view === 'history') loadHistory();
}

function init() {
  for (const field of document.querySelectorAll('[data-field]')) field.addEventListener('input', () => { current.values[field.dataset.field] = field.value; render(); });
  for (const button of document.querySelectorAll('.nav-button')) button.addEventListener('click', () => showView(button.dataset.view));
  $('imageInput').addEventListener('change', (event) => event.target.files[0] && upload(event.target.files[0]).catch((error) => setStatus(error.message, true)));
  $('uploadButton').addEventListener('click', () => $('imageInput').click());
  $('saveButton').addEventListener('click', save);
  $('exportButton').addEventListener('click', () => { setStatus('Na janela de impressão, escolha "Salvar como PDF".'); preparePrint(); window.print(); });
  $('historySearch').addEventListener('input', () => { historyOffset = 0; loadHistory(); });
  $('historyList').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.edit) editCard(button.dataset.edit);
    if (button.dataset.copy) duplicateCard(button.dataset.copy);
    if (button.dataset.delete) deleteCard(button.dataset.delete);
  });
  loadValues();
}

document.fonts?.ready?.then(fitCardBody);
window.addEventListener('resize', fitCardBody);
window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', fitCardBody);

if (await requirePosCards()) init();
