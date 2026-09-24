import { fetchAPI, fetchAPIAsset, fetchAPIPage } from '../js/auth.js';
import { collectEditableFields } from './field-registry.js';
import { createInlineEditor } from './inline-editor.js';
import { createDraftState } from './draft-state.js';
import { CARD_GEOMETRY as MODULE_CARD_GEOMETRY, fitPreview } from './card-geometry.js';
import { observePreviewLayout } from './preview-layout.js';
import { attachRichInput, normalizeRichHtml, richTextLength as moduleRichTextLength, richTextToPlainText as moduleRichTextToPlainText } from './rich-text.js';

const requests = { fetchAPI, fetchAPIAsset, fetchAPIPage };
export function mount(page) {
const { fetchAPI, fetchAPIAsset, fetchAPIPage } = page.bindAPI(requests);
const $ = (id) => document.getElementById(id);
const guestDefaults = {
  heroTitle: 'Um convite', heroEmphasis: 'a viver o seu tempo', heroBrand: 'Owntime',
  salutation: 'Olá, Nome Sobrenome.',
  greeting: 'Você é nosso convidado para viver uma experiência no <strong>Owntime Home Club Gramado:</strong>',
  stayInfo: 'Responsável:\nHóspede: X adultos e X crianças\nUnidade: casa/apto número / ocupação máxima: X\nCheck-in:xx/xx\nCheck-out: xx/xx',
  experienceTitle: 'Sua experiência inclui:',
  experienceBody: 'Hospedagem com acesso aos espaços de lazer de uso comum disponíveis no Club House Owntime.',
  consumptionTitle: 'Consumos da hospedagem:',
  consumptionBody: 'Água, energia elétrica, gás e demais consumos relacionados à estadia.',
  notIncludedTitle: 'O que não está incluso:',
  notIncludedBody: 'Alimentação, bebidas e serviços sob demanda serão cobrados à parte.',
  afterStay: 'Como parte da experiência, após a estadia, o presenteado deverá preencher a pesquisa de satisfação pós-estada, compartilhando sua percepção sobre a hospedagem e contribuindo para o aprimoramento contínuo da experiência Owntime.',
  conditions: 'Necessária reserva prévia e sujeita à disponibilidade de datas.\nConsulte as condições de utilização deste convite.',
  contact: '54 3421 9988',
};
const ownerDefaults = {
  heroTitle: 'Confirmação de',
  heroEmphasis: 'reserva',
  heroBrand: 'Owntime',
  salutation: 'Olá,',
  greeting: 'Você é nosso convidado para viver uma experiência <strong>Owntime Home Club Gramado:</strong>',
  stayInfo: 'Responsável:\nHóspede: X adultos e X crianças\nUnidade: casa/apto número / ocupação máxima: X\nCheck-in:xx/xx\nCheck-out: xx/xx\nCortesia: um almoço.',
  address: '<strong>Como chegar:</strong> Rua João XXIII, 222, Centro - Gramado',
  includedIntro: 'Para que sua estada seja a mais confortável e transparente possível, alinhamos abaixo os serviços que já estão inclusos na sua hospedagem e as despesas que são contabilizadas à parte.',
  includedTitle: 'O que já está INCLUSO na sua estadia:',
  cleaning: '<strong>Serviço de Limpeza:</strong> Você tem direito a 1 limpeza completa com troca de enxoval durante o período. Para utilizá-la, basta fazer o agendamento com 24h de antecedência na recepção.',
  support: '<strong>Equipe de Apoio e portaria:</strong> 24h à disposição para ajudar você no que for preciso.',
  paidTitle: 'O que é PAGO (Consumo individual):',
  utilities: '<strong>GÁS GLP</strong>, água e energia elétrica referentes à sua unidade, proporcionais ao período da estadia.',
  pet: '<strong>Hospedagem Pet:</strong> Cobrança diária de R$ 85,00 por animal.',
  servicesIntro: 'Solicite ao time de anfitriões durante a estadia (valores sob consulta):',
  gastronomy: 'Gastronomia',
  chef: 'Chef em Casa',
  extraCleaning: 'Limpeza adicional.',
  babysitter: 'Babysitter',
  trainer: 'Personal trainer',
  carWash: 'Car wash',
  hostNote: 'O time de anfitriões entrará em contato com você até 7 dias antes de sua hospedagem.',
  footerLabel: 'CENTRAL DE RELACIONAMENTO',
  contact: '54 3421 9988',
  footerEmail: 'contato@ownerinc.com.br',
};
const GUEST_COVER_ASSET = './cards-pos/assets/guest/guest-cover.jpg';
const OWNER_COVER_ASSET = './cards-pos/assets/owner/owner-cover.jpg';
const ADDRESS_LABEL = 'Como chegar:';
const ADDRESS_TEXT = 'Rua João XXIII, 222, Centro - Gramado';
const FOOTER_ASSET = './cards-pos/assets/footer.svg';
const PDF_RENDER_SCALE = 3;
const CARD_GEOMETRY = typeof MODULE_CARD_GEOMETRY === 'undefined' ? { convite_owntime: { width: 1448, height: 2347, pdfWidth: 108, pdfHeight: 175.1 }, convite_owner: { width: 862, height: 1984, pdfWidth: 108, pdfHeight: 248.6 } } : MODULE_CARD_GEOMETRY;
const draftStore = (typeof createDraftState === 'function' ? createDraftState : (defaults => {
  const data = Object.fromEntries(Object.entries(defaults).map(([template, values]) => [template, { values: { ...values }, mediaId: null, mediaUrl: '', editingId: null, name: '', baseline: JSON.stringify([values, null]), generation: 0 }]));
  return { get: template => data[template], setValue: (template, key, value) => { data[template].values[key] = value; }, setMedia: (template, media) => Object.assign(data[template], media), snapshot: template => JSON.stringify([data[template].values, data[template].mediaId]), isDirty: template => template ? data[template].baseline !== JSON.stringify([data[template].values, data[template].mediaId]) : Object.keys(data).some(key => data[key].baseline !== JSON.stringify([data[key].values, data[key].mediaId])), loadSaved(card, mediaUrl = '') { Object.assign(data[card.template], { values: { ...card.values }, mediaId: card.mediaId, mediaUrl, editingId: card.id, name: card.name || '', baseline: JSON.stringify([card.values, card.mediaId]) }); }, beginSave(template, name) { const item = data[template]; return { template, generation: item.generation, editingId: item.editingId, name, values: { ...item.values }, mediaId: item.mediaId, snapshot: JSON.stringify([item.values, item.mediaId]) }; }, acceptSave(ticket, response) { Object.assign(data[ticket.template], { editingId: response?.id || data[ticket.template].editingId, name: response?.name || ticket.name, baseline: ticket.snapshot }); return true; } };
})({ convite_owntime: guestDefaults, convite_owner: ownerDefaults }));
let current = { template: 'convite_owntime', values: { ...guestDefaults }, ownerValues: { ...ownerDefaults }, mediaId: null, mediaUrl: '', editingId: null, name: '' };
if (typeof draftStore !== 'undefined') for (const template of ['convite_owntime', 'convite_owner']) {
  Object.defineProperties(current, {
    [template === 'convite_owner' ? 'ownerValues' : 'values']: { configurable: true, get: () => draftStore.get(template).values, set: value => { draftStore.get(template).values = value; } },
  });
}
if (typeof draftStore !== 'undefined') for (const key of ['mediaId', 'mediaUrl', 'editingId', 'name']) Object.defineProperty(current, key, {
  configurable: true, get: () => draftStore.get(current.template)[key],
  set: value => { draftStore.get(current.template)[key] = value; },
});
let historyRequest = 0;
let historyOffset = 0;
let mediaOperationToken = 0;
let activeMediaPromise = null;
let activeEditor = null;
let exportInProgress = false;
let saving = false;
const savedSnapshots = new Map();
const snapshot = (template = current.template) => typeof draftStore !== 'undefined' ? draftStore.snapshot(template) : JSON.stringify([template === 'convite_owner' ? current.ownerValues : current.values, template === current.template ? current.mediaId : null]);
const isDirty = () => (typeof draftStore !== 'undefined' ? draftStore.isDirty() : [...savedSnapshots].some(([template, saved]) => snapshot(template) !== saved)) || (typeof inlineEditor !== 'undefined' && inlineEditor?.hasPendingChanges?.());
let inlineEditor = null;
let layoutUpdate = null;
const richControllers = [];
const canLeave = () => {
  if (typeof inlineEditor !== 'undefined' && inlineEditor && !inlineEditor.flush()) {
    setStatus('Conclua ou cancele a edição do campo antes de sair.', true);
    return false;
  }
  if (saving || activeMediaPromise || exportInProgress || page.busy) {
    setStatus('Aguarde a operação do convite terminar.', true);
    return false;
  }
  return !isDirty()
    || window.confirm('Há alterações dos Cards Pós que ainda não foram salvas. Sair mesmo assim?');
};
page.beforeLeave(canLeave);
page.listen(window, 'beforeunload', event => {
  if (!saving && !activeMediaPromise && !exportInProgress && !isDirty()) return;
  event.preventDefault(); event.returnValue = '';
});
page.cleanup(() => { ++historyRequest; ++mediaOperationToken; replaceMediaUrl(''); });
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

function richCopy(value, className = '', editKey = '') {
  return `<div class="rich-copy${className ? ` ${className}` : ''}">${esc(value)}</div>`;
}

function setStatus(message, error = false) {
  if (!page.active) return;
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('is-error', error);
  const historyStatus = $('history-status');
  const historyView = $('historyView');
  if (historyStatus && historyView?.classList && !historyView.classList.contains('hidden')) { historyStatus.textContent = message; historyStatus.classList.toggle('is-error', error); }
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
  return `<section class="hero"><div class="guest-photo"><img class="hero-image" src="${esc(media)}" alt=""></div><div class="hero-content"><h2>${esc(v.heroTitle)}<em>${esc(v.heroEmphasis)}</em></h2><div class="guest-wordmark"><img src="./cards-pos/assets/owntime-logo-white.webp" alt="Owntime"></div></div><div class="gold-rule"></div></section><section class="card-body guest-body"><div class="card-copy"><div class="guest-intro">${richCopy(v.salutation, 'guest-salutation', 'salutation')}${richCopy(v.greeting, 'greeting', 'greeting')}${richCopy(v.stayInfo, 'stay-info', 'stayInfo')}</div><div class="benefit-box"><h3>${esc(v.experienceTitle)}</h3>${richCopy(v.experienceBody)}<div class="inline-copy"><strong>${esc(v.consumptionTitle)}</strong> ${esc(v.consumptionBody)}</div><h3>${esc(v.notIncludedTitle)}</h3>${richCopy(notIncludedBody)}</div>${renderAddress()}</div></section>${renderFooter(v)}`;
}

function renderOwnerTemplate(v) {
  const media = current.mediaUrl || OWNER_COVER_ASSET;
  const icon = (name) => `<img class="owner-icon" src="./cards-pos/assets/owner/${name}" alt="">`;
  const info = (name, value, key) => `<div class="owner-info-row owner-${key}">${name ? icon(name) : '<span class="owner-icon" aria-hidden="true"></span>'}${richCopy(value, '', key)}</div>`;
  const service = (name, value, key) => `<div class="owner-extra-service owner-${key}">${icon(name)}${richCopy(value, '', key)}</div>`;
  return `<section class="hero owner-hero"><img class="hero-image" src="${esc(media)}" alt=""><div class="hero-content"><h2>${esc(v.heroTitle)}<em>${esc(v.heroEmphasis)}</em></h2><div class="hero-brand">${esc(v.heroBrand)}</div></div><div class="gold-rule"></div></section><section class="card-body owner-body"><div class="card-copy">${richCopy(v.salutation, 'owner-salutation')}${richCopy(v.greeting, 'owner-greeting')}<div class="owner-stay-box">${richCopy(v.stayInfo)}</div>${richCopy(v.address, 'owner-address')}<section class="owner-included">${richCopy(v.includedIntro, 'owner-intro')}<h3>${esc(v.includedTitle)}</h3>${info('icon-cleaning.svg', v.cleaning, 'cleaning')}${info('icon-support.svg', v.support, 'support')}</section><section class="owner-paid"><h3>${esc(v.paidTitle)}</h3>${info('', v.utilities, 'utilities')}${info('icon-pet.svg', v.pet, 'pet')}</section><section class="owner-services">${richCopy(v.servicesIntro, 'owner-services-intro')}<div class="owner-services-grid">${service('icon-food.svg', v.gastronomy, 'gastronomy')}${service('icon-babysitter.svg', v.babysitter, 'babysitter')}${service('icon-chef.svg', v.chef, 'chef')}${service('icon-trainer.svg', v.trainer, 'trainer')}${service('icon-cleaning-extra.svg', v.extraCleaning, 'extraCleaning')}${service('icon-car.svg', v.carWash, 'carWash')}</div></section>${richCopy(v.hostNote, 'owner-host-note')}</div></section>${renderOwnerFooter(v)}`;
}

function renderOwnerFooter(v) {
  return `<footer class="card-footer owner-footer"><span class="owner-footer-rule" aria-hidden="true"></span><div class="owner-footer-contact"><strong data-edit-key="footerLabel">${esc(v.footerLabel)}</strong><div><span data-edit-key="contact">${esc(phoneFromContact(v.contact))}</span><span aria-hidden="true">|</span><span data-edit-key="footerEmail">${esc(v.footerEmail)}</span></div></div><img src="./cards-pos/assets/owner/ownerinc-logo.svg" alt="Ownerinc"></footer>`;
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
  const markerMap = owner ? {
    heroTitle: '.hero h2', heroEmphasis: '.hero h2 em', heroBrand: '.hero-brand', salutation: '.owner-salutation', greeting: '.owner-greeting', stayInfo: '.owner-stay-box', address: '.owner-address', includedIntro: '.owner-intro', includedTitle: '.owner-included h3', cleaning: '.owner-cleaning .rich-copy', support: '.owner-support .rich-copy', paidTitle: '.owner-paid h3', utilities: '.owner-utilities .rich-copy', pet: '.owner-pet .rich-copy', servicesIntro: '.owner-services-intro', gastronomy: '.owner-gastronomy .rich-copy', chef: '.owner-chef .rich-copy', extraCleaning: '.owner-extraCleaning .rich-copy', babysitter: '.owner-babysitter .rich-copy', trainer: '.owner-trainer .rich-copy', carWash: '.owner-carWash .rich-copy', hostNote: '.owner-host-note', footerLabel: '.owner-footer-contact strong', contact: '.owner-footer-contact > div span:first-child', footerEmail: '.owner-footer-contact > div span:last-child',
  } : {
    heroTitle: '.hero h2', heroEmphasis: '.hero h2 em', salutation: '.guest-salutation', greeting: '.greeting', stayInfo: '.stay-info', experienceTitle: '.benefit-box h3:nth-of-type(1)', experienceBody: '.benefit-box .rich-copy:nth-of-type(1)', consumptionTitle: '.inline-copy strong', consumptionBody: '.inline-copy', notIncludedBody: '.benefit-box .rich-copy:last-child', contact: '.footer-phone-editable',
  };
  Object.entries(markerMap).forEach(([key, selector]) => card.querySelector(selector)?.setAttribute('data-edit-key', key));
  card.querySelector('.hero-image')?.setAttribute('data-edit-media', 'cover');
  // html2canvas supports background cover, but not img object-fit; keep the img for asset validation.
  const photo = card.querySelector('.guest-photo');
  if (photo) photo.style.backgroundImage = `url("${photo.firstElementChild.src}")`;
  card.querySelectorAll('img').forEach((image) => page.listen(image, 'load', fitCardBody, { once: true }));
  page.frame(fitCardBody);
}

function fitCardBody(root = $('cardCanvas')) {
  const target = root && typeof root.querySelector === 'function' ? root : $('cardCanvas');
  const body = target?.querySelector('.card-body');
  const copy = target?.querySelector('.card-copy');
  if (!body || !copy) return;
  copy.style.transform = 'none';
  copy.style.width = '100%';
  const styles = getComputedStyle(body);
  const available = body.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
  if (available <= 0) return;
  const scale = Math.min(1, Math.max(0, available - 1) / copy.scrollHeight);
  if (scale < 1) {
    copy.style.transform = `scale(${scale})`;
  }
}

function nextFrame() {
  return page.wait(new Promise((resolve) => page.frame(resolve)));
}

async function waitForImage(image) {
  if (!image.complete) {
    await page.image(image.src);
  }
  if (!image.naturalWidth) throw new Error('Não foi possível carregar uma imagem do card.');
  if (image.decode) {
    try { await page.wait(image.decode()); } catch { page.assertActive(); /* Imagens já carregadas ainda podem ser renderizadas. */ }
  }
}

async function waitForCardAssets(card) {
  await page.wait(document.fonts?.ready);
  await Promise.all([...card.querySelectorAll('img')].map(waitForImage));
  await nextFrame();
  await nextFrame();
}

function pdfFileName() {
  const source = current.name || richTextToPlainText(activeValues().heroBrand) || 'convite-owntime';
  const safe = source.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return safe || 'convite-owntime';
}

async function exportPdf() {
  if (exportInProgress) return;
  if (typeof inlineEditor !== 'undefined' && inlineEditor && !inlineEditor.flush()) { setStatus('Conclua a edição antes de exportar.', true); return; }
  if (activeMediaPromise) {
    setStatus('Aguarde o carregamento da imagem antes de exportar.', true);
    return;
  }
  if (!window.html2canvas || !window.jspdf?.jsPDF) throw new Error('O exportador de PDF ainda está carregando. Tente novamente em instantes.');
  const source = $('cardCanvas');
  const geometry = CARD_GEOMETRY[current.template];
  const size = { width: geometry.pdfWidth, height: geometry.pdfHeight };
  // ponytail: one fixed Guest artboard keeps mobile and desktop PDFs identical.
  const bounds = { width: geometry.width, height: geometry.height };
  if (!size || !bounds.width || !bounds.height) throw new Error('Não foi possível preparar o card para exportação.');
  const fileName = pdfFileName();

  exportInProgress = true;
  const surface = document.createElement('div');
  surface.className = 'pos-card-export-surface';
  surface.setAttribute('aria-hidden', 'true');
    const card = source.cloneNode(true);
    card.removeAttribute('id');
    card.querySelectorAll('[data-edit-key], [data-edit-media], [data-inline-action], [contenteditable], #card-inline-layer').forEach(node => {
      if (node.id === 'card-inline-layer') node.remove();
      else { node.removeAttribute('data-edit-key'); node.removeAttribute('data-edit-media'); node.removeAttribute('contenteditable'); }
    });
    card.querySelectorAll('#card-inline-layer').forEach(node => node.remove());
    card.style.transform = 'none'; card.style.zoom = '1'; card.style.width = `${geometry.width}px`; card.style.height = `${geometry.height}px`;
  card.removeAttribute('id');
  card.style.width = `${bounds.width}px`;
  card.style.height = `${bounds.height}px`;
  card.style.maxWidth = 'none';
  card.style.boxShadow = 'none';
  surface.append(card);
  document.body.append(surface);
  page.cleanup(() => surface.remove());
  try {
    await waitForCardAssets(card);
    fitCardBody(card);
    await nextFrame();
    fitCardBody(card);
    const canvas = await page.wait(window.html2canvas(card, {
      backgroundColor: '#fff',
       scale: current.template === 'convite_owntime' ? 1 : PDF_RENDER_SCALE,
      useCORS: true,
      logging: false,
      width: bounds.width,
      height: bounds.height,
    }));
    const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: [size.width, size.height], orientation: 'portrait', compress: true });
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, size.width, size.height, undefined, 'FAST');
    pdf.save(`${fileName}.pdf`);
    setStatus('PDF baixado com o card completo.');
  } finally {
    surface.remove();
    if (page.active) fitCardBody();
    exportInProgress = false;
  }
}

function activeValues() {
  return current.template === 'convite_owner' ? current.ownerValues : current.values;
}

function richTextLength(value) { return moduleRichTextLength(value); }
function richTextToPlainText(value) { return moduleRichTextToPlainText(value); }

function normalizeRichField(field, value) {
  let html = normalizeRichHtml(value, { multiline: field.getAttribute('aria-multiline') === 'true' });
  if (field.getAttribute('aria-multiline') !== 'true') {
    html = html.replace(/<\/li><li>/g, ' ').replace(/<\/?(?:ul|ol|li)>/g, '').replace(/<br>/g, ' ');
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
    editor.dataset.multiline = String(multiline);
    editor.dataset.maxlength = field.maxLength > 0 ? String(field.maxLength) : '';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', String(multiline));
    if (field.dataset.field) editor.dataset.field = field.dataset.field;
    if (field.dataset.ownerField) editor.dataset.ownerField = field.dataset.ownerField;
    const label = field.closest('label');
    if (label) {
      const labelText = [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim();
      if (labelText) editor.setAttribute('aria-label', labelText);
      page.listen(label, 'click', () => editor.focus());
    }
    page.listen(editor, 'focus', () => { activeEditor = editor; });
    page.listen(editor, 'keydown', (event) => {
      if (!multiline && event.key === 'Enter') event.preventDefault();
    });
    page.listen(editor, 'paste', (event) => {
      event.preventDefault();
      const pasted = event.clipboardData?.getData('text/html') || event.clipboardData?.getData('text/plain') || '';
      const html = sanitizeRichHtml(pasted);
      document.execCommand('insertHTML', false, multiline ? html : html.replace(/<br>/g, ' '));
      updateRichField(editor);
    });
    const richController = attachRichInput({ node: editor, maxLength: field.maxLength > 0 ? field.maxLength : 100000, multiline, feedback: message => setStatus(message, true), page });
    richControllers.push(richController);
    page.cleanup(() => richController.dispose());
    field.replaceWith(editor);
    page.cleanup(() => { if (editor.isConnected) editor.replaceWith(field); });
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
  document.querySelector('.rich-toolbar')?.remove();
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
    page.listen(button, 'mousedown', (event) => event.preventDefault());
    page.listen(button, 'click', () => {
      if (!activeEditor) return;
      activeEditor.focus();
      document.execCommand(command, false, null);
      updateRichField(activeEditor);
    });
    toolbar.append(button);
  }
  $('cardForm').prepend(toolbar);
  page.cleanup(() => toolbar.remove());
  page.listen(document, 'selectionchange', updateToolbarState);
  updateToolbarState();
}

function loadValues(values = {}, template = current.template) {
  const owner = template === 'convite_owner';
  const target = owner ? current.ownerValues : current.values;
  if (values && Object.keys(values).length) Object.assign(target, values);
  if (!owner && !Object.prototype.hasOwnProperty.call(values, 'notIncludedBody') && values.foodInfo) target.notIncludedBody = values.foodInfo;
  const source = owner ? current.ownerValues : current.values;
  const attribute = owner ? 'data-owner-field' : 'data-field';
  for (const field of document.querySelectorAll(`[${attribute}]`)) {
    const name = field.getAttribute(attribute);
    const value = name === 'contact' ? phoneFromContact(source[name]) : source[name];
    source[name] = setRichFieldValue(field, value);
  }
  richControllers.forEach(controller => controller.sync?.());
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
  $('previewLabel').textContent = `Preview do convite · 108 × ${owner ? '248,6' : '175,1'} mm`;
  $('moduleTitle').textContent = owner ? 'Convite para Owners' : 'Convite para convidados';
  $('moduleDescription').textContent = owner
    ? 'Edite todos os textos do Frame 02, revise o card e exporte o PDF.'
    : 'Preencha os textos, escolha uma imagem e revise o convite no preview ao lado.';
  $('editorTitle').textContent = owner ? 'Monte o card do Owner' : 'Monte seu convite';
}

function switchModule(template) {
  if (saving || activeMediaPromise || page.busy || exportInProgress) return;
  if (typeof inlineEditor !== 'undefined' && inlineEditor && !inlineEditor.flush()) return;
  if (!['convite_owntime', 'convite_owner'].includes(template)) return;
  activeEditor = null;
  updateToolbarState();
  current.template = template;
  updateModuleControls();
  loadValues(activeValues());
  layoutUpdate?.();
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
    if (page.active && activeMediaPromise === promise) {
      activeMediaPromise = null;
      setMediaBusy(false);
    }
  }
}

async function upload(file) {
  if (exportInProgress) return;
  return runMediaOperation(async (operationToken) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Escolha uma imagem PNG, JPEG ou WebP.');
    const previewUrl = page.objectURL(file);
    const dimensions = await page.image(previewUrl).then(image => [image.naturalWidth, image.naturalHeight])
      .finally(() => URL.revokeObjectURL(previewUrl));
    if (operationToken !== mediaOperationToken) return;
    if (dimensions.some((value) => value < 500)) throw new Error('A imagem precisa ter pelo menos 500 × 500 px.');
    setStatus('Enviando imagem...');
    const media = await fetchAPI('/api/pos-cards/media', { method: 'POST', headers: { 'content-type': file.type }, body: file });
    if (operationToken !== mediaOperationToken) return;
    const mediaUrl = await fetchAPIAsset(media.url || `/api/pos-cards/media/${media.id}`);
    if (operationToken !== mediaOperationToken) { URL.revokeObjectURL(mediaUrl); return; }
    current.mediaId = media.id;
    replaceMediaUrl(mediaUrl);
    render();
    setStatus('Imagem adicionada ao convite.');
  });
}

async function save() {
  if (saving || activeMediaPromise || exportInProgress) return;
  if (typeof inlineEditor !== 'undefined' && inlineEditor && !inlineEditor.flush()) return;
  const dialog = $('card-name-dialog'); const input = $('card-name-input'); const feedback = $('card-name-feedback');
  input.value = current.name || richTextToPlainText(activeValues().heroBrand) || 'Convite Owntime'; feedback.textContent = '';
  if (!dialog?.showModal) {
    const legacyName = window['pr' + 'ompt']?.('Nome do convite:', input.value);
    if (!legacyName?.trim()) return;
    input.value = legacyName;
    return saveWithName(input.value.trim());
  }
  dialog.showModal();
  const result = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  const name = input.value.trim();
  if (result !== 'save' || name.length < 1 || name.length > 120) { if (result === 'save') feedback.textContent = 'Use entre 1 e 120 caracteres.'; return; }
  return saveWithName(name);
}

async function saveWithName(name) {
  const button = $('saveButton');
  saving = true;
    const ticket = typeof draftStore !== 'undefined'
      ? draftStore.beginSave(current.template, name.trim())
      : { template: current.template, generation: 0, editingId: current.editingId, name: name.trim(), values: JSON.parse(JSON.stringify(activeValues())), mediaId: current.mediaId, snapshot: snapshot() };
  button.disabled = true;
  setStatus('Salvando convite...');
  try {
     const editing = Boolean(ticket.editingId);
     const saved = await fetchAPI(editing ? `/api/pos-cards/cards/${ticket.editingId}` : '/api/pos-cards/cards', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ name: ticket.name, template: ticket.template, values: ticket.values, mediaId: ticket.mediaId }),
     });
      if (typeof draftStore !== 'undefined') draftStore.acceptSave(ticket, saved);
      else { current.editingId = saved.id; current.name = saved.name || name.trim(); savedSnapshots.set(ticket.template, ticket.snapshot); }
    setStatus('Convite salvo no histórico.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saving = false;
    button.disabled = false;
  }
}

function renderHistory(cards) {
  $('historyList').innerHTML = cards.map((card) => `<article class="history-item"><div><strong>${esc(card.name)}</strong><small>${card.template === 'convite_owner' ? 'Owner' : 'Convidado'} · Atualizado em ${esc(new Date(card.updatedAt).toLocaleDateString('pt-BR'))}</small></div><div class="history-actions"><button type="button" data-edit="${esc(card.id)}">Editar</button><button type="button" data-copy="${esc(card.id)}">Duplicar</button><button type="button" data-delete="${esc(card.id)}">Excluir</button></div></article>`).join('');
  $('historyEmpty').classList.toggle('hidden', cards.length > 0);
  $('history-status').textContent = `${cards.length} item(ns) carregados.`;
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
    button.dataset.historyOffset = String(offset);
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
  if (typeof inlineEditor !== 'undefined' && inlineEditor && !inlineEditor.flush()) return;
  if (!canLeave()) return;
  activeEditor = null;
  updateToolbarState();
  setStatus('Carregando convite...');
  try {
    await runMediaOperation(async (operationToken) => {
      const card = await fetchAPI(`/api/pos-cards/cards/${encodeURIComponent(id)}`);
      if (operationToken !== mediaOperationToken) return;
      const mediaUrl = card.mediaId ? await fetchAPIAsset(`/api/pos-cards/media/${card.mediaId}`) : '';
      if (operationToken !== mediaOperationToken) { if (mediaUrl) URL.revokeObjectURL(mediaUrl); return; }
       const targetDraft = draftStore.get(card.template);
      if (targetDraft?.mediaUrl?.startsWith('blob:')) URL.revokeObjectURL(targetDraft.mediaUrl);
      draftStore.loadSaved(card, mediaUrl);
      current.template = card.template;
      updateModuleControls();
      loadValues({}, card.template);
      render();
      showView('editor');
      setStatus('Convite carregado para edição.');
    });
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function duplicateCard(id) {
  if (exportInProgress) return;
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
  if (exportInProgress) return;
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
  if (exportInProgress) return;
  if (view !== 'editor' && typeof inlineEditor !== 'undefined' && inlineEditor && !inlineEditor.flush()) return;
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
  for (const field of document.querySelectorAll('[data-rich-editor="true"]')) {
    page.listen(field, 'input', () => updateRichField(field));
  }
  loadValues(current.ownerValues, 'convite_owner');
  loadValues();
  for (const button of document.querySelectorAll('.module-button')) {
    page.listen(button, 'click', () => switchModule(button.dataset.module === 'owner' ? 'convite_owner' : 'convite_owntime'));
  }
  for (const button of document.querySelectorAll('.nav-button')) page.listen(button, 'click', () => showView(button.dataset.view));
  page.listen($('imageInput'), 'change', (event) => event.target.files[0] && upload(event.target.files[0]).catch((error) => setStatus(error.message, true)));
  page.listen($('uploadButton'), 'click', () => $('imageInput').click());
  const inline = createInlineEditor({
    root: $('card-inline-layer'), canvas: $('cardCanvas'), fields: collectEditableFields($('cardForm')),
    page, getTemplate: () => current.template,
    readValue: (template, key) => String((template === 'convite_owner' ? current.ownerValues : current.values)[key] || ''),
    normalizeValue: (value, field) => normalizeRichHtml(value, { multiline: field.multiline }),
    richInput: attachRichInput,
    onCommit: ({ template, key, value }) => { draftStore.setValue(template, key, value); render(); },
    uploadButton: $('uploadButton'),
  });
  inlineEditor = inline;
  page.cleanup(() => inline.dispose());
  page.listen($('cardCanvas'), 'click', event => { const target = event.target.closest('[data-edit-key]'); if (target && window.matchMedia('(max-width: 900px)').matches) inline.open(target.dataset.editKey); if (event.target.closest('[data-edit-media]') && window.matchMedia('(max-width: 900px)').matches) $('imageInput').click(); });
  page.listen(document, 'keydown', event => { if (event.key === 'Escape') inline.cancel(); });
  const viewport = window.visualViewport;
  const repositionInline = () => {
    const layer = $('card-inline-layer');
    if (!layer || layer.hidden) return;
    const keyboardTop = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    layer.style.maxHeight = `${Math.max(160, keyboardTop - 12)}px`;
    layer.style.paddingBottom = 'max(12px, env(safe-area-inset-bottom))';
  };
  if (viewport) { page.listen(viewport, 'resize', repositionInline); page.listen(viewport, 'scroll', repositionInline); }
  page.listen(window, 'resize', repositionInline);
  layoutUpdate = observePreviewLayout({ container: document.querySelector('.preview-stage'), frame: () => CARD_GEOMETRY[current.template], wrapper: document.querySelector('.preview-artboard'), mode: () => window.matchMedia('(max-width: 900px)').matches ? 'mobile' : 'desktop', page });
  page.listen($('saveButton'), 'click', save);
  page.listen($('exportButton'), 'click', async () => {
    if (typeof inlineEditor !== 'undefined' && inlineEditor && !inlineEditor.flush()) return;
    const button = $('exportButton');
    button.disabled = true;
    setStatus('Gerando PDF...');
    try { await exportPdf(); } catch (error) { setStatus(error.message, true); }
    finally { button.disabled = false; }
  });
  page.listen($('historySearch'), 'input', () => { historyOffset = 0; loadHistory(); });
  page.listen($('historyList'), 'click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.edit) editCard(button.dataset.edit);
    if (button.dataset.copy) duplicateCard(button.dataset.copy);
    if (button.dataset.delete) deleteCard(button.dataset.delete);
  });
  page.listen($('historyPagination'), 'click', event => {
    const button = event.target.closest('button[data-history-offset]');
    if (!button || button.disabled) return;
    historyOffset = Number(button.dataset.historyOffset);
    loadHistory();
  });
}

document.fonts?.ready?.then(() => { if (page.active) fitCardBody(); });
page.listen(window, 'resize', fitCardBody);
updateModuleControls();
init();
document.body.classList.add('cards-pos-editing');
page.cleanup(() => { document.body.classList.remove('cards-pos-editing'); layoutUpdate = null; });
for (const template of ['convite_owntime', 'convite_owner']) savedSnapshots.set(template, snapshot(template));
}
