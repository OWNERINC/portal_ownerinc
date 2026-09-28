import { fitPreview } from './card-geometry.js';
export function observePreviewLayout({ container, frame, wrapper, toolbar, mode = 'fit', page } = {}) {
  const update = () => {
    // Mobile is a scrolling page: reserve one screen for the preview before
    // the form. Document-relative top stays stable while the user scrolls.
    if (container?.style && window.matchMedia) {
      if (window.matchMedia('(max-width: 900px)').matches) {
        const top = container.getBoundingClientRect().top + window.scrollY;
        const height = window.visualViewport?.height || window.innerHeight;
        container.style.height = `${Math.max(180, height - top - 16)}px`;
      } else container.style.removeProperty('height');
    }
    const styles = typeof getComputedStyle === 'function' && container ? getComputedStyle(container) : {};
    const padding = name => parseFloat(styles[name]) || 0;
    const available = {
      width: Math.max(0, (container?.clientWidth || 0) - padding('paddingLeft') - padding('paddingRight')),
      height: Math.max(0, (container?.clientHeight || 0) - padding('paddingTop') - padding('paddingBottom')),
    };
    const result = fitPreview(typeof frame === 'function' ? frame() : frame, available, typeof mode === 'function' ? mode() : mode);
    wrapper?.style.setProperty('--preview-width', `${result.width}px`);
    wrapper?.style.setProperty('--preview-height', `${result.height}px`);
    return result;
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  if (container) observer?.observe(container);
  if (toolbar) observer?.observe(toolbar);
  page?.listen(window, 'resize', update);
  if (window.visualViewport) page?.listen(window.visualViewport, 'resize', update);
  update();
  page?.cleanup(() => observer?.disconnect());
  return update;
}
