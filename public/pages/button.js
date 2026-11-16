import { el } from './dom.js';
import { safeLink } from './model.js';
import { v3Icon } from './render-blocks-v3.js';

// Local line geometry, matching the arrow/download/play/upload/check vocabulary
// in reference-1. No icon font, remote asset, HTML or document-supplied SVG.
const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6', download: 'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5',
  play: 'm7 3 14 9-14 9Z', upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6', check: 'm4 12 5 5L20 6',
};
function localIcon(name) {
  if (!Object.hasOwn(paths, name)) { const icon = v3Icon(name); if (icon) { icon.classList.remove('pages-block-icon'); return icon; } }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key,value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key,value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.arrow); svg.append(path); return svg;
}
function validDownload(action) {
  const ext = { image: 'webp', gif: 'gif', audio: 'mp3', video: 'mp4' }[action.kind];
  return ext && typeof action.file_name === 'string' && action.file_name.length <= 120
    && !/[\\/\u0000-\u001f\u007f-\u009f]/u.test(action.file_name) && action.file_name.endsWith(`.${ext}`)
    && action.file_name.slice(0, -(ext.length + 1)).trim();
}

// UI-only commands: context.command='upload'|'save', canAuthor===true, and
// onCommand({command,signal}) => Promise<{acknowledged:true}>. The caller adapts
// its actual API ACK, not click/file-selection completion. Never serialized.
export function createPageButton({ label, preset = 'primary', icon, action, context = {} }) {
  const command = !action && ['save','upload'].includes(context.command) ? context.command : null;
  const variant = ['primary','secondary','text','video','upload'].includes(preset) ? preset : 'primary';
  const navigation = action?.type === 'section' || (action?.type === 'url' && safeLink(action.value));
  const node = el(navigation ? 'a' : 'button', { className: `pages-content-button pages-button-${variant} pages-action-button`,
    ...(navigation ? { href: action.type === 'section' ? sectionURL(action.value) : action.value } : { type: 'button' }), 'aria-label': label });
  const text = el('span', { className: 'pages-button-label', text: label });
  const status = el('span', { className: 'pages-button-status', role: 'status', 'aria-live': 'polite' });
  const defaultIcon = command === 'upload' ? 'upload' : action?.type === 'download' ? 'download' : action?.type === 'video' ? 'play' : 'arrow';
  let glyph = icon === 'none' ? null : localIcon(icon || defaultIcon);
  if (glyph) node.append(glyph);
  node.append(text, status); node.dataset.preset = variant;
  let active = true, busy = false, disabled = false, generation = 0, controller, blobURL;
  function sectionURL(id) { const url = new URL(window.location.href); url.hash = `section-${id}`; return url.href; }
  function unavailable() {
    return !action && (!command || context.canAuthor !== true || typeof context.onCommand !== 'function');
  }
  function sync() {
    const blocked = disabled || busy || !active || unavailable() || (action?.type === 'url' && !navigation);
    node.setAttribute('aria-disabled', String(blocked));
    if (node.tagName === 'BUTTON') node.disabled = blocked;
    else if (blocked) node.removeAttribute('href');
    else node.setAttribute('href', action.type === 'section' ? sectionURL(action.value) : action.value);
    node.setAttribute('aria-busy', String(busy));
  }
  function revoke() { if (blobURL) URL.revokeObjectURL(blobURL); blobURL = null; }
  async function activate(event) {
    if (disabled || busy || !active || context.signal?.aborted || unavailable()) { event.preventDefault(); return; }
    if (action?.type === 'url') { if (!navigation) event.preventDefault(); return; }
    if (action?.type === 'section') {
      if (!/^[0-9a-f-]{36}$/iu.test(action.value)) { event.preventDefault(); return; }
      if (context.staged || context.revisionId) {
        // Preview is local focus, not a visit/history entry in the owning shell.
        event.preventDefault();
        const target = context.host?.querySelector(`[id="section-${action.value}"]`);
        if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); }
      }
      // Published anchors retain native same-document fragment navigation. The
      // shell's existing hash handling owns indices, activeURL and restoration.
      return;
    }
    event.preventDefault();
    if (command && node.dataset.preset === 'confirmed') {
      node.dataset.preset = variant; text.textContent = label; node.setAttribute('aria-label', label);
      const original = icon === 'none' ? null : localIcon(icon || defaultIcon);
      glyph?.remove(); glyph = original; if (glyph) node.insertBefore(glyph, text);
    }
    busy = true; sync(); status.textContent = 'Carregando…';
    const request = ++generation; controller = new AbortController();
    try {
      if (action?.type === 'download') {
        if (!validDownload(action)) throw new Error('Invalid download');
        const value = await context.api.download(context.pageId, action.media_id, { revisionId: context.revisionId, staged: context.staged, signal: controller.signal });
        if (!active || request !== generation || context.signal?.aborted) { URL.revokeObjectURL(value); return; }
        blobURL = value;
        if (typeof value !== 'string' || !value.startsWith('blob:')) throw new Error('Private blob required');
        const anchor = el('a'); anchor.href = value; anchor.download = action.file_name;
        document.body.append(anchor);
        try { anchor.click(); } finally { anchor.remove(); revoke(); }
        status.textContent = 'Download iniciado.';
      } else if (action?.type === 'video') {
        const target = context.resolveBlock?.(action.value);
        if (!['video','video_embed'].includes(target?.type) || typeof context.activateVideo !== 'function') throw new Error('Video unavailable');
        await context.activateVideo(action.value, { signal: controller.signal });
        if (active && request === generation) status.textContent = 'Use os controles do vídeo. Reprodução não iniciada.';
      } else if (command) {
        const result = context.onCommand({ command, signal: controller.signal });
        if (!result || typeof result.then !== 'function') throw new Error('Promise ACK required');
        const ack = await result;
        if (!active || request !== generation || context.signal?.aborted) return;
        if (ack?.acknowledged !== true) throw new Error('ACK required');
        if (command === 'save' && ack.current !== false) {
          text.textContent = 'Salvo'; node.setAttribute('aria-label','Salvo'); node.dataset.preset = 'confirmed';
          const checked = localIcon('check'); if (glyph) glyph.replaceWith(checked); else node.insertBefore(checked, text); glyph = checked;
          status.textContent = 'Salvamento confirmado.';
        } else status.textContent = command === 'save' ? 'Revisão enviada confirmada. Há alterações não salvas.' : 'Envio confirmado.';
      } else throw new Error('Unsupported action');
    } catch (error) {
      revoke();
      if (active && request === generation && error.name !== 'AbortError') status.textContent = 'Não foi possível concluir. Tente novamente.';
    } finally {
      if (active && request === generation) { busy = false; controller = null; sync(); }
    }
  }
  function dispose() {
    if (!active) return;
    active = false; generation++; controller?.abort(); controller = null; revoke(); sync();
    node.removeEventListener('click', activate); context.signal?.removeEventListener('abort', dispose);
  }
  node.addEventListener('click', activate); context.signal?.addEventListener('abort', dispose, { once: true });
  sync(); if (context.signal?.aborted) dispose();
  return { node, dispose, setDisabled(value) { disabled = Boolean(value); sync(); },
    resetConfirmation() {
      if (node.dataset.preset !== 'confirmed') return;
      node.dataset.preset = variant; text.textContent = label; node.setAttribute('aria-label',label); status.textContent = '';
      glyph?.remove(); glyph = icon === 'none' ? null : localIcon(icon || defaultIcon); if (glyph) node.insertBefore(glyph,text);
    } };
}
