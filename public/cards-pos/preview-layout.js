import { fitPreview } from './card-geometry.js';
export function observePreviewLayout({ container, frame, wrapper, toolbar, mode = 'fit', page } = {}) {
  let disposed = false;
  let pendingFrame = null;
  let result;
  let writtenHeight;
  const written = new Map();
  const write = (name, value) => {
    if (!wrapper?.style || written.get(name) === value) return;
    wrapper.style.setProperty(name, value);
    written.set(name, value);
  };
  // Explicit updates remain synchronous for model/mode switches and a return
  // from the hidden history view. Only observer/viewport notifications queue.
  const update = () => {
    if (disposed || page?.active === false) return result;
    // Mobile is a scrolling page: reserve one screen for the preview before
    // the form. Document-relative top stays stable while the user scrolls.
    if (container?.style && window.matchMedia) {
      if (window.matchMedia('(max-width: 900px)').matches) {
        const top = container.getBoundingClientRect().top + window.scrollY;
        const height = window.visualViewport?.height || window.innerHeight;
        const value = `${Math.max(180, height - top - 16)}px`;
        if (writtenHeight !== value) {
          if (container.style.height !== value) container.style.height = value;
          writtenHeight = value;
        }
      } else {
        if (container.style.height) container.style.removeProperty('height');
        writtenHeight = '';
      }
    }
    const styles = typeof getComputedStyle === 'function' && container ? getComputedStyle(container) : {};
    const padding = name => parseFloat(styles[name]) || 0;
    const available = {
      width: Math.max(0, (container?.clientWidth || 0) - padding('paddingLeft') - padding('paddingRight')),
      height: Math.max(0, (container?.clientHeight || 0) - padding('paddingTop') - padding('paddingBottom')),
    };
    result = fitPreview(typeof frame === 'function' ? frame() : frame, available, typeof mode === 'function' ? mode() : mode);
    // Cache our values rather than comparing browser-rounded CSS serialization.
    write('--preview-width', `${result.width}px`);
    write('--preview-height', `${result.height}px`);
    return result;
  };
  const schedule = () => {
    if (disposed || page?.active === false || pendingFrame !== null) return;
    pendingFrame = (page?.frame || requestAnimationFrame)(() => {
      pendingFrame = null;
      update();
    });
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  if (container) observer?.observe(container);
  if (toolbar) observer?.observe(toolbar);
  page?.listen(window, 'resize', schedule);
  if (window.visualViewport) page?.listen(window.visualViewport, 'resize', schedule);
  update();
  page?.cleanup(() => {
    disposed = true;
    observer?.disconnect();
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  });
  return update;
}
