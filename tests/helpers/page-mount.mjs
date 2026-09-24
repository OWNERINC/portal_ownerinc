// Existing DOM doubles exercise page behavior; router/lifecycle tests separately
// use the real cancellation scope. Expose internals from inside a fresh mount.
export function mountSource(source, expose = '', { user = 'globalThis.user || {}' } = {}) {
  source = source.replace(/^export function mount\(/m, 'function mount(');
  const end = source.lastIndexOf('}');
  return `${source.slice(0, end)}\n${expose}\n${source.slice(end)}
mount({
  user: ${user}, active: true, busy: false,
  history: typeof history === 'undefined' ? {} : history,
  location: typeof location === 'undefined' ? {} : location,
  bindAPI: api => api,
  toast: typeof showToast === 'undefined' ? () => {} : showToast,
  cleanup() {}, beforeLeave(guard) { globalThis.leaveGuard = guard; },
  canLeave() { return globalThis.leaveGuard?.() !== false; },
  listen(target, type, listener, options) { target?.addEventListener(type, listener, options); },
  timeout: typeof setTimeout === 'undefined' ? () => {} : setTimeout,
  frame: typeof requestAnimationFrame === 'undefined' ? () => {} : requestAnimationFrame,
  wait: promise => Promise.resolve(promise),
  objectURL: blob => URL.createObjectURL(blob),
  image: src => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src;
  }),
});`;
}

export const activePageDouble = {
  active: true,
  listen(target, type, listener, options) { target?.addEventListener(type, listener, options); },
};
