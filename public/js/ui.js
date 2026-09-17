const BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls',
  'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap',
  'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open',
  'playsinline', 'readonly', 'required', 'reversed', 'selected',
]);

const BOOLEAN_PROPERTIES = {
  allowfullscreen: 'allowFullscreen',
  formnovalidate: 'formNoValidate',
  ismap: 'isMap',
  itemscope: 'itemScope',
  nomodule: 'noModule',
  novalidate: 'noValidate',
  playsinline: 'playsInline',
  readonly: 'readOnly',
};

export function clear(node) {
  if (!node) return node;
  node.replaceChildren();
  return node;
}

export function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (value == null) return;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'on') Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
    else if (BOOLEAN_ATTRIBUTES.has(key.toLowerCase())) {
      const attribute = key.toLowerCase();
      const enabled = value !== false;
      if (enabled) node.setAttribute(attribute, '');
      else node.removeAttribute(attribute);
      const property = BOOLEAN_PROPERTIES[attribute] || attribute;
      if (property in node) node[property] = enabled;
    } else node.setAttribute(key, String(value));
  });
  node.append(...(Array.isArray(children) ? children : [children]));
  return node;
}

export function setBusy(node, busy) {
  if (node) node.setAttribute('aria-busy', String(Boolean(busy)));
  return node;
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function showState(container, message, retry) {
  if (!container) return null;
  const state = element('div', { className: 'empty-state', role: retry ? 'alert' : 'status' }, [
    element('p', { text: message }),
  ]);
  if (retry) state.append(element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: retry } }));
  clear(container).append(state);
  return state;
}

let activeDialog = null;
let restoreFocus = null;
let inertSiblings = [];
const dialogCloseGuards = new WeakMap();
const initialValues = new WeakMap();
const guardedForms = new Map();

function serializeForm(form) {
  return JSON.stringify([...new FormData(form).entries()]);
}

function formValue(dialog) {
  const form = dialog.querySelector('form');
  if (!form) return '';
  return serializeForm(form);
}

function isDirty(dialog) {
  return initialValues.has(dialog) && initialValues.get(dialog) !== formValue(dialog);
}

function hasUnavailableAncestor(node) {
  let current = node;
  while (current) {
    if (current.hidden || current.inert || current.classList?.contains('hidden') || current.getAttribute?.('aria-hidden') === 'true') return true;
    current = current.parentNode;
  }
  return false;
}

function isFocusTargetAvailable(node) {
  return Boolean(node && node !== document.body && node.isConnected !== false
    && !node.hidden && !node.disabled && !node.inert && !hasUnavailableAncestor(node)
    && node.style?.display !== 'none');
}

export function openDialog(backdrop, initialFocus) {
  restoreFocus = document.activeElement;
  activeDialog = backdrop;
  initialValues.set(backdrop, formValue(backdrop));
  backdrop.classList.remove('hidden');
  inertSiblings = [...document.body.children].filter(node => node !== backdrop && node.tagName !== 'SCRIPT');
  inertSiblings.forEach(node => { node.inert = true; });
  document.body.classList.add('modal-open');
  (initialFocus || backdrop.querySelector('input, select, textarea, button'))?.focus();
}

export function setDialogCloseGuard(backdrop, guard) {
  if (typeof guard === 'function') dialogCloseGuards.set(backdrop, guard);
  else dialogCloseGuards.delete(backdrop);
}

export function canCloseDialog(backdrop) {
  if (!backdrop) return true;
  if (dialogCloseGuards.get(backdrop)?.() === false) return false;
  return !isDirty(backdrop) || window.confirm('Descartar alterações não salvas?');
}

export function closeDialog(backdrop, force = false) {
  if (!force && !canCloseDialog(backdrop)) return false;
  backdrop.classList.add('hidden');
  document.body.classList.remove('modal-open');
  inertSiblings.forEach(node => { node.inert = false; });
  inertSiblings = [];
  initialValues.delete(backdrop);
  activeDialog = null;
  if (isFocusTargetAvailable(restoreFocus)) restoreFocus.focus();
  else {
    const fallback = [
      backdrop.closest('section, main')?.querySelector('h1, h2, h3, [role="heading"]'),
      document.querySelector('main:not([hidden]) h1, main:not([hidden]) h2, main:not([hidden]) h3, main:not([hidden]) [role="heading"]'),
    ].find(isFocusTargetAvailable);
    fallback?.setAttribute('tabindex', '-1');
    fallback?.focus();
  }
  restoreFocus = null;
  return true;
}

document.querySelectorAll('.table-wrapper').forEach(wrapper => {
  if (wrapper.hasAttribute('role')) return;
  const caption = wrapper.querySelector('caption');
  wrapper.setAttribute('role', 'region');
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-label', caption?.textContent?.trim() || 'Tabela com rolagem horizontal');
});

export function protectForm(form) {
  const markClean = () => guardedForms.set(form, serializeForm(form));
  markClean();
  return markClean;
}

document.addEventListener('keydown', event => {
  if (!activeDialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog(activeDialog);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...activeDialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

document.addEventListener('click', event => {
  if (activeDialog && event.target === activeDialog) closeDialog(activeDialog);
});

window.addEventListener('beforeunload', event => {
  const persistentDirty = [...guardedForms].some(([form, initial]) => serializeForm(form) !== initial);
  if ((!activeDialog || !isDirty(activeDialog)) && !persistentDirty) return;
  event.preventDefault();
  event.returnValue = '';
});
