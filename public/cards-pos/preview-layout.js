import { fitPreview } from './card-geometry.js';
export function observePreviewLayout({ container, frame, wrapper, mode = 'desktop', page } = {}) {
  const update = () => { const available = { width: container?.clientWidth || 0, height: container?.clientHeight || 0 }; const result = fitPreview(typeof frame === 'function' ? frame() : frame, available, typeof mode === 'function' ? mode() : mode); wrapper?.style.setProperty('--preview-width', `${result.width}px`); wrapper?.style.setProperty('--preview-height', `${result.height}px`); return result; };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null; observer?.observe(container); page?.listen(window, 'resize', update); update();
  page?.cleanup(() => observer?.disconnect()); return update;
}
