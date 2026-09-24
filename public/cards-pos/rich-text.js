const TAGS = new Set(['STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'BR', 'UL', 'OL', 'LI']);
export function sanitizeRichHtml(value) {
  const text = String(value ?? '');
  return text.replace(/<!--[^]*?-->|<\/?([a-z][a-z0-9:-]*)(?:\s[^<>]*)?>/gi, (match, raw) => {
    const tag = raw?.toUpperCase(); if (!tag || !TAGS.has(tag)) return '';
    return `<${match.startsWith('</') ? '/' : ''}${tag.toLowerCase()}>`;
  }).replace(/\r?\n/g, '<br>');
}
export function richTextToPlainText(value) { return String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '); }
export function richTextLength(value) { return Array.from(richTextToPlainText(value)).length; }
export function normalizeRichHtml(value, { multiline = true } = {}) { const html = sanitizeRichHtml(value); return multiline ? html : html.replace(/<br>/g, ' '); }
export function attachRichInput({ node, maxLength, multiline = true, onChange = () => {}, feedback, page } = {}) {
  let composing = false; let last = node?.innerHTML || '';
  const check = event => { if (composing) return; const next = normalizeRichHtml(node.innerHTML, { multiline }); if (richTextLength(next) > maxLength) { node.innerHTML = last; feedback?.('Limite de caracteres atingido.'); return; } last = next; onChange(next, event); };
  const listeners = [['beforeinput', event => { if (!composing && event.inputType?.startsWith('insert') && richTextLength(node.innerText || '') >= maxLength && !getSelection()?.toString()) event.preventDefault(); }], ['input', check], ['compositionstart', () => { composing = true; }], ['compositionend', check]];
  listeners.forEach(([type, fn]) => node?.addEventListener(type, fn));
  return {
    sync() { last = normalizeRichHtml(node?.innerHTML || '', { multiline }); },
    flush() { if (composing) return false; check(); return richTextLength(last) <= maxLength; },
    dispose() { listeners.forEach(([type, fn]) => node?.removeEventListener(type, fn)); },
  };
}
