import { fetchAPI, fetchAPIAsset, fetchAPIPage } from '../js/auth.js';
import { requirePosCards } from './guard.js';

const $ = (id) => document.getElementById(id);
const guestDefaults = {
  heroTitle: 'Este é um convite', heroEmphasis: 'para viver o seu tempo', heroBrand: 'Owntime',
  greeting: 'Você é nosso convidado para viver uma experiência <strong>Owntime Home Club Gramado:</strong>',
  stayInfo: 'Responsável:\nHóspede: X adultos e X crianças\nUnidade: casa/apto número / ocupação máxima: X\nCheck-in:xx/xx\nCheck-out: xx/xx',
  experienceTitle: 'Sua experiência inclui:',
  experienceBody: 'Hospedagem com acesso aos espaços de lazer de uso comum disponíveis no Club House Owntime.',
  consumptionTitle: 'Consumos da hospedagem:',
  consumptionBody: 'Água, energia elétrica, gás e demais consumos relacionados à estadia.',
  notIncludedTitle: 'O que não está incluso:',
  notIncludedBody: 'Alimentação, bebidas e serviços on demand serão cobrados à parte.',
  afterStay: 'Como parte da experiência, após a estadia, o presenteado deverá preencher a pesquisa de satisfação pós-estada, compartilhando sua percepção sobre a hospedagem e contribuindo para o aprimoramento contínuo da experiência Owntime.',
  conditions: 'Necessária reserva prévia e sujeita à disponibilidade de datas.\nConsulte as condições de utilização deste convite.',
  contact: '54 3421 9988',
};
const ownerDefaults = {
  heroTitle: 'Confirmação de',
  heroEmphasis: 'reserva',
  heroBrand: 'Owntime',
  recipientName: 'Fulano da Silva Santos',
  greeting: 'Você é nosso convidado para viver uma experiência <strong>Owntime Home Club Gramado:</strong>',
  stayInfo: 'Responsável:\nHóspede: X adultos e X crianças\nUnidade: casa/apto número / ocupação máxima: X\nCheck-in:xx/xx\nCheck-out: xx/xx\nCortesia: um almoço.',
  experienceTitle: 'Sua experiência inclui:',
  experienceBody: 'Hospedagem com acesso aos espaços de lazer de uso comum disponíveis no Club House Owntime.',
  includedConsumptionTitle: 'Consumos da hospedagem:',
  includedConsumptionBody: 'Água, energia elétrica, gás e demais consumos relacionados à estadia.',
  notIncludedTitle: 'O que não está incluso:',
  notIncludedBody: 'Alimentação, bebidas e serviços on demand serão cobrados à parte.',
  includedIntro: 'Para que sua estada seja a mais confortável e transparente possível, alinhamos abaixo os serviços que já estão inclusos na sua hospedagem e as despesas que são contabilizadas à parte.',
  includedTitle: 'O que já está INCLUSO na sua estadia:',
  cleaningTitle: 'Serviço de Limpeza',
  cleaningBody: 'Você tem direito a 1 limpeza completa com troca de enxoval durante o período. Para utilizá-la, basta fazer o agendamento com 24h de antecedência na recepção.',
  supportTitle: 'Equipe de Apoio',
  supportBody: 'Nossos Anfitriões e Mensageiros/Manobristas estão prontos para ajudar você no que for preciso.',
  securityTitle: 'Segurança e Praticidade',
  securityBody: 'Serviço de portaria 24h à sua disposição para total tranquilidade.',
  consumptionTitle: 'O que é PAGO (Consumo individual):',
  gasTitle: 'GÁS (GLP)',
  gasInfo: 'Aquecimento de Água\n\nLareiras a Gás;\n\nFogão / Cooktop;\n\nAquecimento de Piso e calefação.',
  waterTitle: 'ÁGUA',
  waterInfo: 'Chuveiros de Alta Vazão e Banheiras/Spas;\n\nTorneiras;\n\nEletrodomésticos da Cozinha;',
  energyTitle: 'ENERGIA ELÉTRICA',
  energyInfo: 'Ar-Condicionado;\n\nToalheiros Aquecidos\n\nEletrodomésticos e Gourmet;\n\nIluminação.',
  petTitle: 'Hospedagem Pet',
  petBody: 'sujeito à cobrança diária de R$ 85,00 por animal.',
  servicesIntro: 'Solicite à recepção ou ao seu concierge durante a estadia (valores sob consulta):',
  gastronomyTitle: 'Gastronomia',
  gastronomyBody: 'Restaurante, Bar, Coffee Shop e Café da Manhã.',
  chefTitle: 'Chef em Casa',
  chefBody: 'Experiência culinária privativa na sua unidade.',
  extraCleaningTitle: 'Limpeza Adicional',
  extraCleaningBody: 'Serviços extras de faxina ou troca de enxoval.',
  trainerTitle: 'Personal Trainer',
  trainerBody: 'Acompanhamento profissional exclusivo no fitness center.',
  babysitterTitle: 'Babysitter & Pet Care',
  babysitterBody: 'Cuidados dedicados para seus filhos ou seu pet.',
  carWashTitle: 'Car Wash',
  carWashBody: 'Estética e lavagem automotiva sem precisar sair do condomínio.',
  conditions: 'Necessária reserva prévia e sujeita à disponibilidade de datas.\nConsulte as condições de utilização deste convite.',
  contact: '54 3421 9988',
};
const GUEST_COVER_ASSET = './cards-pos/assets/guest/guest-cover.jpg';
const OWNER_COVER_ASSET = './cards-pos/assets/owner/owner-cover.jpg';
const ADDRESS_LABEL = 'Como chegar:';
const ADDRESS_TEXT = 'Rua João XXIII, 222, Centro - Gramado';
const FOOTER_ASSET = './cards-pos/assets/footer.svg';
let current = {
  template: 'convite_owntime',
  values: { ...guestDefaults },
  ownerValues: { ...ownerDefaults },
  mediaId: null,
  mediaUrl: '',
  editingId: null,
  name: '',
};
let historyRequest = 0;
let historyOffset = 0;
let mediaOperationToken = 0;
let activeMediaPromise = null;
let activeEditor = null;
const HISTORY_PAGE_SIZE = 50;
const RICH_VALUE = Symbol('rich-value');
const RICH_TAGS = new Set(['STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'BR', 'UL', 'OL', 'LI']);
const RICH_BLOCK_TAGS = new Set(['DIV', 'P']);
const RICH_BLOCK_COMMANDS = new Set(['insertUnorderedList', 'insertOrderedList']);
const RICH_TAG_PATTERN = /<!--[\s\S]*?-->|<\/?([a-z][a-z0-9:-]*)(?:\s[^<>]*)?>/gi;

function esc(value) {
  if (value && typeof value === 'object' && value[RICH_VALUE]) return toRichHtml(value.value);
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

function escapeRichText(value) {
  return String(value)
    .replace(/&(?!(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

function sanitizeRichHtml(value) {
  const source = String(value ?? '');
  let output = '';
  let cursor = 0;
  const openTags = [];
  for (const match of source.matchAll(RICH_TAG_PATTERN)) {
    output += escapeRichText(source.slice(cursor, match.index));
    const tag = match[1]?.toUpperCase();
    if (tag && RICH_TAGS.has(tag)) {
      if (tag === 'BR') output += '<br>';
      else if (match[0].startsWith('</')) {
        const index = openTags.lastIndexOf(tag);
        if (index >= 0) {
          while (openTags.length > index + 1) output += `</${openTags.pop().toLowerCase()}>`;
          output += `</${openTags.pop().toLowerCase()}>`;
        }
      } else {
        output += `<${tag.toLowerCase()}>`;
        openTags.push(tag);
      }
    } else if (tag && RICH_BLOCK_TAGS.has(tag)) {
      if (match[0].startsWith('</')) {
        const remainder = source.slice(match.index + match[0].length);
        if (remainder.trim() && !/^<(?:div|p|br)\b/i.test(remainder.trim())) output += '<br>';
      } else if (output && !output.endsWith('<br>')) output += '<br>';
    }
    cursor = match.index + match[0].length;
  }
  output += escapeRichText(source.slice(cursor));
  while (openTags.length) output += `</${openTags.pop().toLowerCase()}>`;
  return output.replace(/(?:<br>)+$/, '<br>');
}

function toRichHtml(value) {
  return sanitizeRichHtml(value);
}

function richValues(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { [RICH_VALUE]: true, value }]));
}

function richCopy(value, className = '') {
  return `<div class="rich-copy${className ? ` ${className}` : ''}">${esc(value)}</div>`;
}

function setStatus(message, error = false) {
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('is-error', error);
}

function phoneFromContact(value) {
  const source = value && typeof value === 'object' && value[RICH_VALUE] ? value.value : value;
  const text = String(source ?? '').trim();
  const match = text.match(/(?:\+\d{1,3}\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}/);
  return (match?.[0] || text.replace(/[^\d+().\s-]/g, '')).trim().slice(0, 24);
}

function renderFooter(v) {
  return `<footer class="card-footer"><img class="footer-art" src="${FOOTER_ASSET}" alt="Ownerinc"><span class="footer-phone-backdrop" aria-hidden="true"></span><span class="footer-phone-editable">${esc(phoneFromContact(v.contact))}</span></footer>`;
}

function renderAddress() {
  return `<p class="address-line"><strong>${ADDRESS_LABEL}</strong> <span>${ADDRESS_TEXT}</span></p>`;
}

function renderGuest(v) {
  const media = current.mediaUrl || GUEST_COVER_ASSET;
  const notIncludedBody = v.notIncludedBody || v.foodInfo;
  return `<section class="hero"><img class="hero-image" src="${esc(media)}" alt=""><div class="hero-content"><h2>${esc(v.heroTitle)}<em>${esc(v.heroEmphasis)}</em></h2><div class="hero-brand">${esc(v.heroBrand)}</div></div><div class="gold-rule"></div></section><section class="card-body"><div class="card-copy">${richCopy(v.greeting, 'greeting')}${richCopy(v.stayInfo, 'stay-info')}<div class="benefit-box"><h3>${esc(v.experienceTitle)}</h3>${richCopy(v.experienceBody)}<div class="inline-copy"><strong>${esc(v.consumptionTitle)}</strong> ${esc(v.consumptionBody)}</div><h3>${esc(v.notIncludedTitle)}</h3>${richCopy(notIncludedBody)}</div>${renderAddress()}</div></section>${renderFooter(v)}`;
}

function renderOwnerTemplate(v) {
  const media = current.mediaUrl || OWNER_COVER_ASSET;
  const icon = (name, label = '') => `<img class="owner-icon" src="./cards-pos/assets/owner/${name}" alt="${label}">`;
  const service = (iconName, title, body) => `<div class="owner-service">${icon(iconName)}<div class="owner-service-copy"><strong>${esc(title)}:</strong> ${esc(body)}</div></div>`;
  return `<section class="hero owner-hero"><img class="hero-image" src="${esc(media)}" alt=""><div class="hero-content"><h2>${esc(v.heroTitle)}<em>${esc(v.heroEmphasis)}</em></h2><div class="hero-brand">${esc(v.heroBrand)}</div></div><div class="gold-rule"></div></section><section class="card-body owner-body"><div class="card-copy"><div class="owner-recipient">Olá, ${esc(v.recipientName)}</div>${richCopy(v.greeting, 'greeting')}<div class="owner-stay-box">${richCopy(v.stayInfo)}</div>${renderAddress()}<section class="owner-included">${richCopy(v.includedIntro)}<h3>${esc(v.includedTitle)}</h3>${service('icon-cleaning.svg', v.cleaningTitle, v.cleaningBody)}${service('icon-support.svg', v.supportTitle, v.supportBody)}${service('icon-security.svg', v.securityTitle, v.securityBody)}</section><section class="owner-consumption"><h3>${esc(v.consumptionTitle)}</h3><div class="consumption-grid"><div><strong>${esc(v.gasTitle)}</strong>${richCopy(v.gasInfo)}</div><div><strong>${esc(v.waterTitle)}</strong>${richCopy(v.waterInfo)}</div><div><strong>${esc(v.energyTitle)}</strong>${richCopy(v.energyInfo)}</div></div></section><div class="owner-pet">${icon('icon-pet.svg')}<div class="owner-pet-copy"><strong>${esc(v.petTitle)}:</strong> ${esc(v.petBody)}</div></div><section class="owner-services">${richCopy(v.servicesIntro)}${service('icon-food.svg', v.gastronomyTitle, v.gastronomyBody)}${service('icon-chef.svg', v.chefTitle, v.chefBody)}${service('icon-cleaning-extra.svg', v.extraCleaningTitle, v.extraCleaningBody)}${service('icon-trainer.svg', v.trainerTitle, v.trainerBody)}${service('icon-babysitter.svg', v.babysitterTitle, v.babysitterBody)}${service('icon-car.svg', v.carWashTitle, v.carWashBody)}</section></div></section>${renderFooter(v)}`;
}

function renderOwner(v) {
  return renderOwnerTemplate(v);
}

function render() {
  const owner = current.template === 'convite_owner';
  const values = richValues(owner ? current.ownerValues : current.values);
  const card = $('cardCanvas');
  card.className = `invite-card ${owner ? 'owner-card' : 'guest-card'}`;
  card.innerHTML = owner ? renderOwner(values) : renderGuest(values);
  card.querySelectorAll('img').forEach((image) => image.addEventListener('load', fitCardBody, { once: true }));
  requestAnimationFrame(fitCardBody);
}

function fitCardBody() {
  const body = document.querySelector('.card-body');
  const copy = document.querySelector('.card-copy');
  if (!body || !copy) return;
  copy.style.transform = 'none';
  copy.style.width = '100%';
  const styles = getComputedStyle(body);
  const available = body.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
  if (available <= 0) return;
  const scale = Math.min(1, available / copy.scrollHeight);
  if (scale < 1) {
    copy.style.transform = `scale(${scale})`;
    copy.style.width = `${100 / scale}%`;
  }
}

function preparePrint() {
  document.body.classList.toggle('printing-owner', current.template === 'convite_owner');
  fitCardBody();
}

function activeValues() {
  return current.template === 'convite_owner' ? current.ownerValues : current.values;
}

function richTextLength(value) {
  const container = document.createElement('div');
  container.innerHTML = value;
  return container.textContent.length + container.querySelectorAll('br').length;
}

function richTextToPlainText(value) {
  const container = document.createElement('div');
  container.innerHTML = toRichHtml(value);
  return container.textContent.replace(/\s+/g, ' ').trim();
}

function normalizeRichField(field, value) {
  let html = toRichHtml(value);
  if (field.getAttribute('aria-multiline') !== 'true') {
    html = html.replace(/<\/li><li>/g, ' ').replace(/<\/?(?:ul|ol|li)>/g, '').replace(/<br>/g, ' ');
  }
  const maxLength = Number(field.dataset.maxlength);
  if (maxLength && richTextLength(html) > maxLength) {
    const container = document.createElement('div');
    container.innerHTML = html;
    let text = container.textContent.slice(0, maxLength);
    if (text.length && /[\uD800-\uDBFF]/.test(text[text.length - 1])) text = text.slice(0, -1);
    container.textContent = text;
    html = sanitizeRichHtml(container.innerHTML);
  }
  return html;
}

function setRichFieldValue(field, value) {
  const html = normalizeRichField(field, value);
  if (field.dataset.richEditor === 'true') field.innerHTML = html;
  else field.value = value ?? '';
  return html;
}

function upgradeRichFields() {
  for (const field of document.querySelectorAll('[data-field], [data-owner-field]')) {
    const editor = document.createElement('div');
    const multiline = field.tagName === 'TEXTAREA';
    editor.id = field.id;
    editor.className = `rich-editor${multiline ? ' is-multiline' : ''}`;
    editor.contentEditable = 'true';
    editor.dataset.richEditor = 'true';
    editor.dataset.maxlength = field.maxLength > 0 ? String(field.maxLength) : '';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', String(multiline));
    if (field.dataset.field) editor.dataset.field = field.dataset.field;
    if (field.dataset.ownerField) editor.dataset.ownerField = field.dataset.ownerField;
    const label = field.closest('label');
    if (label) {
      const labelText = [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim();
      if (labelText) editor.setAttribute('aria-label', labelText);
      label.addEventListener('click', () => editor.focus());
    }
    editor.addEventListener('focus', () => { activeEditor = editor; });
    editor.addEventListener('keydown', (event) => {
      if (!multiline && event.key === 'Enter') event.preventDefault();
    });
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      const pasted = event.clipboardData?.getData('text/html') || event.clipboardData?.getData('text/plain') || '';
      const html = sanitizeRichHtml(pasted);
      document.execCommand('insertHTML', false, multiline ? html : html.replace(/<br>/g, ' '));
      updateRichField(editor);
    });
    field.replaceWith(editor);
  }
}

function updateRichField(field) {
  const html = normalizeRichField(field, field.innerHTML);
  if (field.innerHTML !== html) field.innerHTML = html;
  const name = field.dataset.ownerField || field.dataset.field;
  activeValues()[name] = html;
  render();
  updateToolbarState();
}

function updateToolbarState() {
  document.querySelectorAll('.rich-toolbar button').forEach((button) => {
    const command = button.dataset.command;
    const blocked = RICH_BLOCK_COMMANDS.has(command) && activeEditor?.getAttribute('aria-multiline') !== 'true';
    button.disabled = !activeEditor || blocked;
    button.setAttribute('aria-disabled', String(button.disabled));
    if (command === 'removeFormat') return;
    const pressed = Boolean(activeEditor && !button.disabled && document.queryCommandState(command));
    button.classList.toggle('active', pressed);
    button.setAttribute('aria-pressed', String(pressed));
  });
}

function createRichToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'rich-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Formatação do campo selecionado');
  const commands = [
    ['bold', 'N', 'Negrito'],
    ['italic', 'I', 'Itálico'],
    ['underline', 'S', 'Sublinhado'],
    ['strikeThrough', 'T', 'Tachado'],
    ['insertUnorderedList', '•', 'Lista com marcadores'],
    ['insertOrderedList', '1.', 'Lista numerada'],
    ['removeFormat', 'Limpar', 'Limpar formatação'],
  ];
  for (const [command, label, title] of commands) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.command = command;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      if (!activeEditor) return;
      activeEditor.focus();
      document.execCommand(command, false, null);
      updateRichField(activeEditor);
    });
    toolbar.append(button);
  }
  $('cardForm').prepend(toolbar);
  document.addEventListener('selectionchange', updateToolbarState);
  updateToolbarState();
}

function loadValues(values = {}, template = current.template) {
  const owner = template === 'convite_owner';
  if (owner) current.ownerValues = { ...ownerDefaults, ...values };
  else {
    current.values = { ...guestDefaults, ...values };
    if (!Object.prototype.hasOwnProperty.call(values, 'notIncludedBody') && values.foodInfo) current.values.notIncludedBody = values.foodInfo;
  }
  const source = owner ? current.ownerValues : current.values;
  const attribute = owner ? 'data-owner-field' : 'data-field';
  for (const field of document.querySelectorAll(`[${attribute}]`)) {
    const name = field.getAttribute(attribute);
    const value = name === 'contact' ? phoneFromContact(source[name]) : source[name];
    source[name] = setRichFieldValue(field, value);
  }
  render();
}

function updateModuleControls() {
  const owner = current.template === 'convite_owner';
  document.querySelectorAll('.module-button').forEach((button) => {
    const active = button.dataset.module === (owner ? 'owner' : 'guest');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('guestFields').classList.toggle('hidden', owner);
  $('ownerFields').classList.toggle('hidden', !owner);
  $('previewLabel').textContent = `Preview do convite · 108 × ${owner ? '290,6' : '175,1'} mm`;
  $('moduleTitle').textContent = owner ? 'Convite para Owners' : 'Convite para convidados';
  $('moduleDescription').textContent = owner
    ? 'Edite os textos da experiência Owner, revise o frame e exporte o convite.'
    : 'Preencha os textos, escolha uma imagem e revise o convite no preview ao lado.';
  $('editorTitle').textContent = owner ? 'Monte o card do Owner' : 'Monte seu convite';
}

function switchModule(template) {
  if (!['convite_owntime', 'convite_owner'].includes(template)) return;
  activeEditor = null;
  updateToolbarState();
  current.template = template;
  updateModuleControls();
  loadValues(activeValues());
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
  const name = window.prompt('Nome do convite:', current.name || richTextToPlainText(activeValues().heroBrand) || 'Convite Owntime');
  if (!name?.trim()) return;
  const button = $('saveButton');
  button.disabled = true;
  setStatus('Salvando convite...');
  try {
    const editing = Boolean(current.editingId);
    const saved = await fetchAPI(editing ? `/api/pos-cards/cards/${current.editingId}` : '/api/pos-cards/cards', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ name: name.trim(), template: current.template, values: activeValues(), mediaId: current.mediaId }),
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
  $('historyList').innerHTML = cards.map((card) => `<article class="history-item"><div><strong>${esc(card.name)}</strong><small>${card.template === 'convite_owner' ? 'Owner' : 'Convidado'} · Atualizado em ${esc(new Date(card.updatedAt).toLocaleDateString('pt-BR'))}</small></div><div class="history-actions"><button type="button" data-edit="${esc(card.id)}">Editar</button><button type="button" data-copy="${esc(card.id)}">Duplicar</button><button type="button" data-delete="${esc(card.id)}">Excluir</button></div></article>`).join('');
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
  activeEditor = null;
  updateToolbarState();
  setStatus('Carregando convite...');
  try {
    await runMediaOperation(async (operationToken) => {
      const card = await fetchAPI(`/api/pos-cards/cards/${encodeURIComponent(id)}`);
      if (operationToken !== mediaOperationToken) return;
      const mediaUrl = card.mediaId ? await fetchAPIAsset(`/api/pos-cards/media/${card.mediaId}`) : '';
      if (operationToken !== mediaOperationToken) return;
      replaceMediaUrl('');
       current = { ...current, template: card.template, editingId: card.id, mediaId: card.mediaId, name: card.name || '' };
       updateModuleControls();
       loadValues(card.values, card.template);
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
  if (view !== 'editor') {
    activeEditor = null;
    updateToolbarState();
  }
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
  createRichToolbar();
  upgradeRichFields();
  for (const field of document.querySelectorAll('[data-field], [data-owner-field]')) {
    field.addEventListener('input', () => updateRichField(field));
  }
  loadValues();
  for (const button of document.querySelectorAll('.module-button')) {
    button.addEventListener('click', () => switchModule(button.dataset.module === 'owner' ? 'convite_owner' : 'convite_owntime'));
  }
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
}

document.fonts?.ready?.then(fitCardBody);
window.addEventListener('resize', fitCardBody);
window.addEventListener('beforeprint', preparePrint);
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing-owner'); fitCardBody(); });

if (await requirePosCards()) {
  updateModuleControls();
  init();
}
