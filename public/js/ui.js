export function clear(node) {
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
    else node.setAttribute(key, value);
  });
  node.append(...(Array.isArray(children) ? children : [children]));
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
  const state = element('div', { className: 'empty-state', role: retry ? 'alert' : 'status' }, [
    element('p', { text: message }),
  ]);
  if (retry) state.append(element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: retry } }));
  clear(container).append(state);
}

let activeDialog = null;
let restoreFocus = null;
let inertSiblings = [];
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

export function closeDialog(backdrop, force = false) {
  if (!force && isDirty(backdrop) && !window.confirm('Descartar alterações não salvas?')) return false;
  backdrop.classList.add('hidden');
  document.body.classList.remove('modal-open');
  inertSiblings.forEach(node => { node.inert = false; });
  inertSiblings = [];
  initialValues.delete(backdrop);
  activeDialog = null;
  restoreFocus?.focus();
  restoreFocus = null;
  return true;
}

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
