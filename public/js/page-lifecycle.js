// No router/UI imports: renderers and tools may use this contract without cycles.
export function createPageLifecycle({ user, history = window.history } = {}) {
  const controller = new AbortController();
  const cleanups = new Set();
  const guards = new Set();
  const mutations = new Set();
  const pending = new Set();
  const timers = new Set();
  const frames = new Set();
  const urls = new Set();
  const page = {
    user, history, signal: controller.signal,
    get active() { return !controller.signal.aborted; },
    get busy() { return mutations.size > 0; },
    assertActive() { if (!page.active) throw new DOMException('Página desmontada.', 'AbortError'); },
    cleanup(fn) { cleanups.add(fn); return fn; },
    beforeLeave(fn) { guards.add(fn); },
    canLeave() {
      if (page.busy) { page.toast('Aguarde a operação em andamento terminar.'); return false; }
      return [...guards].every(guard => guard() !== false);
    },
    listen(target, type, handler, options = {}) {
      const listener = event => { if (page.active) return handler(event); };
      target.addEventListener(type, listener, options);
      page.cleanup(() => target.removeEventListener(type, listener, options));
      return listener;
    },
    timeout(fn, delay) {
      if (!page.active) return null;
      const id = setTimeout(() => { timers.delete(id); if (page.active) fn(); }, delay);
      timers.add(id);
      return id;
    },
    frame(fn) {
      if (!page.active) return null;
      const id = requestAnimationFrame(time => { frames.delete(id); if (page.active) fn(time); });
      frames.add(id);
      return id;
    },
    objectURL(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; },
    wait(promise) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Página desmontada.', 'AbortError'));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (!page.active) abort();
        Promise.resolve(promise).then(value => {
          controller.signal.removeEventListener('abort', abort);
          if (page.active) resolve(value); else abort();
        }, error => { controller.signal.removeEventListener('abort', abort); reject(error); });
      });
    },
    image(src) {
      page.assertActive();
      return new Promise((resolve, reject) => {
        const image = new Image();
        const finish = error => {
          image.onload = null; image.onerror = null;
          controller.signal.removeEventListener('abort', abort);
          if (error) { image.src = ''; reject(error); } else resolve(image);
        };
        const abort = () => finish(new DOMException('Página desmontada.', 'AbortError'));
        controller.signal.addEventListener('abort', abort, { once: true });
        image.onload = () => finish();
        image.onerror = () => finish(new Error('Não foi possível carregar a imagem.'));
        image.src = src;
      });
    },
    toast(message, duration = 3000) {
      if (!page.active) return;
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = message;
      toast.classList.remove('hidden');
      page.timeout(() => toast.classList.add('hidden'), duration);
    },
    bindAPI(api) {
      return Object.fromEntries(Object.entries(api).map(([name, request]) => [name, (path, options = {}) => {
        page.assertActive();
        const method = (options.method || 'GET').toUpperCase();
        const writing = !['GET', 'HEAD'].includes(method);
        const key = `${method}:${path}`;
        if (writing && mutations.has(key)) return Promise.reject(new Error('Esta operação já está em andamento.'));
        if (writing) mutations.add(key);
        const signal = options.signal;
        const child = new AbortController();
        const abort = () => child.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const promise = (async () => {
          try {
            return await page.wait(Promise.resolve(request(path, { ...options, signal: child.signal })).then(result => {
              if (!page.active && name === 'fetchAPIAsset') URL.revokeObjectURL(result);
              page.assertActive();
              if (name === 'fetchAPIAsset') urls.add(result);
              return result;
            }));
          } finally {
            mutations.delete(key);
            controller.signal.removeEventListener('abort', abort);
            signal?.removeEventListener('abort', abort);
          }
        })();
        pending.add(promise);
        promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
      }]));
    },
    async ready() {
      // Includes loaders started by another loader; rejected requests still settle.
      while (page.active && pending.size) await Promise.allSettled([...pending]);
    },
    dispose() {
      if (!page.active) return;
      controller.abort();
      timers.forEach(clearTimeout);
      frames.forEach(cancelAnimationFrame);
      for (const cleanup of [...cleanups].reverse()) {
        try { cleanup(); } catch (error) { console.error('Page cleanup failed', error); }
      }
      urls.forEach(url => URL.revokeObjectURL(url));
      cleanups.clear(); guards.clear(); urls.clear(); timers.clear(); frames.clear();
    },
  };
  return page;
}
