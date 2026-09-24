function plainLength(value) {
  return Array.from(String(value ?? '').replace(/<[^>]*>/g, '')).length;
}

export function createInlineEditor(options) {
  const {
    root, fields = [], getTemplate, readValue, onCommit = () => {},
    onDraftChange = () => {}, normalizeValue = value => value,
    page, richInput,
  } = options;
  let active = null;
  let disposed = false;
  let composing = false;
  let invalid = false;
  const cleanups = [];
  const field = root?.querySelector('#card-inline-field') || root?.ownerDocument?.createElement('div');
  if (field && !field.parentNode && root) root.append(field);
  if (field) {
    field.contentEditable = 'true';
    field.setAttribute('role', 'textbox');
  }
  const feedback = root?.querySelector('#card-inline-feedback');
  const visible = value => { if (root) root.hidden = !value; };
  const readDraft = () => field && ('innerHTML' in field) ? field.innerHTML || '' : field?.value || '';
  const writeDraft = value => { if (!field) return; if ('innerHTML' in field) field.innerHTML = String(value ?? ''); else field.value = String(value ?? ''); };
  const listen = (node, type, handler, options) => {
    if (!node?.addEventListener) return;
    node.addEventListener(type, handler, options);
    cleanups.push(() => node.removeEventListener(type, handler, options));
  };
  const setInvalid = (message = '') => {
    invalid = Boolean(message);
    field?.setAttribute('aria-invalid', String(invalid));
    if (feedback) feedback.textContent = message;
  };
  const richController = richInput?.({
    node: field,
    maxLength: Math.max(1, ...fields.map(item => item.maxLength || 0)),
    multiline: true,
    feedback: message => setInvalid(message),
    page,
  });
  if (richController?.dispose) cleanups.push(() => richController.dispose());
  const validateDraft = () => {
    if (!active || composing) return !composing;
    const normalized = normalizeValue(readDraft(), active);
    const tooLong = active.maxLength > 0 && plainLength(normalized) > active.maxLength;
    setInvalid(tooLong ? `Use até ${active.maxLength} caracteres.` : '');
    onDraftChange(readDraft() !== active.original);
    return !tooLong;
  };
  function open(key) {
    if (disposed) return false;
    const meta = fields.find(item => item.key === key && item.template === getTemplate());
    if (!meta) return false;
    active = { ...meta, original: String(readValue(meta.template, key) || '') };
    writeDraft(normalizeValue(active.original, active));
    richController?.sync?.();
    field?.setAttribute('aria-label', `Editar ${meta.label || key}`);
    field?.setAttribute('aria-multiline', String(meta.multiline));
    setInvalid('');
    visible(true);
    field?.focus();
    return true;
  }
  function flush() {
    if (disposed || !active) return true;
    if (composing || !validateDraft()) return false;
    const value = normalizeValue(readDraft(), active);
    onCommit({ template: active.template, key: active.key, value });
    active = null;
    setInvalid('');
    visible(false);
    onDraftChange(false);
    return true;
  }
  function cancel() {
    if (!active) return true;
    writeDraft(active.original);
    active = null;
    composing = false;
    setInvalid('');
    visible(false);
    onDraftChange(false);
    return true;
  }
  const onInput = () => validateDraft();
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; validateDraft(); };
  const onPaste = event => {
    event.preventDefault?.();
    const html = event.clipboardData?.getData('text/html') || event.clipboardData?.getData('text/plain') || '';
    const safe = normalizeValue(html, active || { multiline: true });
    if (typeof document !== 'undefined' && typeof document.execCommand === 'function') document.execCommand('insertHTML', false, safe);
    else writeDraft(`${readDraft()}${safe}`);
    validateDraft();
  };
  listen(field, 'input', onInput);
  listen(field, 'compositionstart', onCompositionStart);
  listen(field, 'compositionend', onCompositionEnd);
  listen(field, 'paste', onPaste);
  const action = (name, handler) => listen(root?.querySelector(`[data-inline-action="${name}"]`), 'click', handler);
  action('apply', flush);
  action('cancel', cancel);
  action('previous', () => { const index = fields.findIndex(item => item.key === active?.key && item.template === getTemplate()); if (index > 0 && flush()) open(fields[index - 1].key); });
  action('next', () => { const index = fields.findIndex(item => item.key === active?.key && item.template === getTemplate()); if (index >= 0 && index < fields.length - 1 && flush()) open(fields[index + 1].key); });
  page?.cleanup?.(() => dispose());
  function dispose() {
    if (disposed) return;
    disposed = true;
    cleanups.splice(0).forEach(cleanup => cleanup());
    active = null;
    visible(false);
  }
  return {
    open, flush, cancel,
    hasPendingChanges: () => !!active && readDraft() !== active.original,
    refreshAnchors() {}, dispose,
  };
}
