import { el, button } from './dom.js';

// Owned by the visible sheet/panel, never by the document or an EditorView.
// offsetTop matters when a mobile browser pans the visual viewport for a caret.
export function watchVisualViewport(node, onChange = () => {}) {
  const viewport = window.visualViewport;
  const update = () => {
    const height = viewport?.height || window.innerHeight;
    const top = viewport?.offsetTop || 0;
    node.style.setProperty('--pages-visible-height', `${height}px`);
    node.style.setProperty('--pages-visible-top', `${top}px`);
    node.style.setProperty('--pages-visible-bottom', `${Math.max(0, window.innerHeight - height - top)}px`);
    onChange({ height, top });
  };
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  update();
  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    node.style.removeProperty('--pages-visible-height');
    node.style.removeProperty('--pages-visible-top');
    node.style.removeProperty('--pages-visible-bottom');
  };
}

export function visibleFocusTarget(node) {
  if (!node?.isConnected || node.disabled || node.closest('[hidden], [inert]') || !node.getClientRects?.().length) return false;
  const viewport = window.visualViewport, rect = node.getBoundingClientRect();
  let left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  let right = left + (viewport?.width || window.innerWidth), bottom = top + (viewport?.height || window.innerHeight);
  // A layout box may be outside the visual viewport or inside a clipped scroller.
  for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    if (ancestor === node) continue;
    const box = ancestor.getBoundingClientRect();
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
      const edge = box.left + (ancestor.clientLeft || 0);
      left = Math.max(left, edge); right = Math.min(right, edge + (ancestor.clientWidth ?? box.width));
    }
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
      const edge = box.top + (ancestor.clientTop || 0);
      top = Math.max(top, edge); bottom = Math.min(bottom, edge + (ancestor.clientHeight ?? box.height));
    }
  }
  const width = Math.min(rect.right, right) - Math.max(rect.left, left);
  const height = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
  // Small targets must fit entirely; a large editor must fill its available
  // clipped area. A sliver above the keyboard is not a useful focus destination.
  return width > 0 && height > 0 && width >= Math.min(rect.width, right - left) - 0.5 && height >= Math.min(rect.height, bottom - top) - 0.5;
}

export function restoreVisibleFocus(candidates) {
  const targets = candidates.filter(node => node?.isConnected && !node.disabled && !node.closest('[hidden], [inert]') && node.getClientRects?.().length
    && node.matches('button, input, select, textarea, a[href], summary, [tabindex], [contenteditable]:not([contenteditable=false])'));
  let target = targets.find(visibleFocusTarget);
  if (!target) for (const node of targets) {
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const viewport = window.visualViewport, rect = node.getBoundingClientRect();
    // scrollIntoView centers in the layout viewport, which can extend behind a
    // keyboard. Adjust the document to the actual visible center before focusing.
    window.scrollBy({ left: 0, top: (rect.top + rect.bottom) / 2 - ((viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight) / 2), behavior: 'instant' });
    if (visibleFocusTarget(node)) { target = node; break; }
  }
  target?.focus({ preventScroll: true });
  return target;
}

// Native modal semantics handle inert background, focus containment and Escape.
// The panel belongs to one workspace; rebuilding it explicitly closes the panel.
export function openEditorPanel({ page, title, anchor, content, actions, anchorOffset = 0, className = '' }) {
  const opener = anchor || document.activeElement;
  const dialog = el('dialog', { className: `pages-dialog pages-editor-panel ${className}`, 'aria-label': title, 'data-page-overlay': '' });
  let closed = false, stopViewport, anchorObserver, composing = false;
  dialog.addEventListener('compositionstart', () => { composing = true; });
  dialog.addEventListener('compositionend', () => { queueMicrotask(() => { composing = false; }); });
  const close = (restore = true) => {
    if (closed || (restore && composing)) return;
    closed = true; stopViewport?.(); anchorObserver?.disconnect(); window.removeEventListener('popstate', onHistory); window.removeEventListener('scroll', position, true);
    dialog.close(); dialog.remove();
    if (restore && page.active && visibleFocusTarget(opener)) opener.focus({ preventScroll: true });
  };
  const onHistory = () => close();
  const dismiss = button('×', () => close(), { className: 'btn btn-ghost pages-icon-button', 'aria-label': `Fechar ${title}` });
  content.classList.add('pages-panel-body');
  content.addEventListener('focusin', event => event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  dialog.append(el('div', { className: 'pages-panel-heading' }, el('h2', { text: title }), dismiss), content);
  if (actions) dialog.append(actions);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); close(); } });
  // Position before mounting/showing: the first painted/measurable frame must
  // use the trigger, rather than first opening at the CSS fallback position.
  function position() {
    if (anchor && window.innerWidth >= 1100) {
      const box = anchor.getBoundingClientRect();
      dialog.style.setProperty('--panel-left', `${Math.max(16, Math.min(box.left + anchorOffset, window.innerWidth - 416))}px`);
      dialog.style.setProperty('--panel-top', `${Math.max(16, Math.min(box.bottom, window.innerHeight - 300))}px`);
    } else { dialog.style.removeProperty('--panel-left'); dialog.style.removeProperty('--panel-top'); }
  }
  position();
  document.body.append(dialog); dialog.showModal();
  stopViewport = watchVisualViewport(dialog, position);
  if (anchor && typeof ResizeObserver !== 'undefined') {
    // Toolbar wrapping/reparenting can move the trigger without a window resize.
    // Observe its layout owner as well as its own size, before the next paint.
    anchorObserver = new ResizeObserver(position);
    anchorObserver.observe(anchor); if (anchor.parentElement) anchorObserver.observe(anchor.parentElement);
  }
  window.addEventListener('scroll', position, true);
  (content.querySelector('input, select, button') || dismiss).focus();
  window.addEventListener('popstate', onHistory);
  page.cleanup(() => close(false));
  return { close, dialog };
}
