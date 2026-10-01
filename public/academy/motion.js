function reduced() { return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
function finish(node) { node.style.opacity = '1'; node.style.transform = 'none'; }

export function mountAcademyMotion(root, { signal, reducedMotion } = {}) {
  const animations = new Set();
  let disposed = false;
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const isReduced = () => reducedMotion ?? media?.matches ?? reduced();
  const stop = () => { disposed = true; animations.forEach(animation => { try { animation.cancel(); } catch {} }); animations.clear(); root?.querySelectorAll?.('[data-motion-part]').forEach(finish); };
  const play = () => {
    if (!root || disposed) return;
    root.querySelectorAll('[data-motion-part]').forEach((part, index) => {
      if (isReduced() || typeof part.animate !== 'function') return finish(part);
      const animation = part.animate([{ transform: 'translateY(12px) rotate(-6deg)', opacity: 0 }, { transform: 'translateY(0) rotate(0deg)', opacity: 1 }], { duration: 600, delay: index * 70, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
      animations.add(animation); animation.finished.catch(() => {}).finally(() => animations.delete(animation));
    });
  };
  signal?.addEventListener('abort', stop, { once: true }); media?.addEventListener?.('change', play); play();
  return () => { stop(); signal?.removeEventListener('abort', stop); media?.removeEventListener?.('change', play); };
}

export function playCompletion(root, { reducedMotion } = {}) {
  const part = root?.querySelector?.('[data-motion-completion]');
  if (!part) return;
  if ((reducedMotion ?? reduced()) || typeof part.animate !== 'function') return finish(part);
  part.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.035)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'ease-in-out' }).finished.catch(() => {});
}
