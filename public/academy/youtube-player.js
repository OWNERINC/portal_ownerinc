const loaders = new WeakMap();
const TIMEOUT = 15000;
const abortError = () => new DOMException('Aula cancelada.', 'AbortError');
const position = value => Number.isFinite(value) ? Math.min(86400, Math.max(0, value)) : 0;

/** Shared per document; abort belongs to the consumer, never to this loader. */
export function loadYouTubeAPI(doc = document) {
  const win = doc.defaultView;
  if (win.YT?.Player) return Promise.resolve(win.YT);
  if (loaders.has(doc)) return loaders.get(doc);
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  loaders.set(doc, promise);
  const script = doc.createElement('script');
  const previous = win.onYouTubeIframeAPIReady;
  let settled = false;
  let timer;
  function finish(error) {
    if (settled) return;
    settled = true;
    win.clearTimeout(timer);
    script.removeEventListener('error', failed);
    if (win.onYouTubeIframeAPIReady === ready) {
      if (previous === undefined) delete win.onYouTubeIframeAPIReady;
      else win.onYouTubeIframeAPIReady = previous;
    }
    if (error) {
      loaders.delete(doc);
      script.remove();
      reject(error);
    } else resolve(win.YT);
  }
  function ready(...args) {
    if (settled) return;
    try { if (typeof previous === 'function') previous.apply(win, args); }
    finally {
      finish(win.YT?.Player ? null : new Error('API do YouTube indisponível. Tente novamente.'));
    }
  }
  function failed() { finish(new Error('Não foi possível carregar o YouTube. Tente novamente.')); }
  win.onYouTubeIframeAPIReady = ready;
  script.src = 'https://www.youtube.com/iframe_api';
  script.async = true;
  script.addEventListener('error', failed);
  timer = win.setTimeout(() => finish(new Error('O YouTube demorou para responder. Tente novamente.')), TIMEOUT);
  try { doc.head.append(script); } catch (error) { finish(error); }
  return promise;
}

function observe(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(abortError());
      else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export async function createYouTubePlayer({ host, media, startSeconds = 0, signal, onPosition, onEnded, onError }) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  if (!/^[A-Za-z0-9_-]{11}$/.test(media.video_id)) throw new TypeError('Vídeo do YouTube inválido.');
  let YT;
  try { YT = await observe(loadYouTubeAPI(doc), signal); }
  catch (error) { if (error.name !== 'AbortError') onError?.(error); throw error; }
  if (signal?.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const iframe = doc.createElement('iframe');
    const start = Math.floor(position(startSeconds));
    const playerVars = { origin: win.location.origin, playsinline: 1, autoplay: 0, controls: 1, start, enablejsapi: 1 };
    iframe.src = `https://www.youtube-nocookie.com/embed/${media.video_id}?${new URLSearchParams(playerVars)}`;
    const title = host.getAttribute('aria-label') || 'Vídeo da aula';
    const decorate = frame => {
      frame.setAttribute('title', title);
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('allow', 'fullscreen');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    };
    decorate(iframe);
    let player, poll, timeout, destroyed = false, ready = false, playing = false, last = start;
    const disposed = new WeakSet();
    const dispose = target => {
      if (!target || disposed.has(target)) return;
      disposed.add(target);
      target.destroy();
    };
    const stop = () => { win.clearInterval(poll); poll = undefined; };
    const emit = () => { if (!destroyed && ready) onPosition?.(handle.getPosition()); };
    const visibility = () => {
      stop();
      if (!destroyed && ready && playing && !doc.hidden) poll = win.setInterval(emit, 1000);
    };
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      win.clearTimeout(timeout);
      doc.removeEventListener('visibilitychange', visibility);
      signal?.removeEventListener('abort', abort);
      try { dispose(player); } finally {
        iframe.remove();
        if (!ready) reject(abortError());
      }
    }
    function abort() { destroy(); }
    function fail(error) {
      if (destroyed) return;
      reject(error);
      destroy();
      onError?.(error);
    }
    const handle = {
      getPosition() { if (!destroyed && ready) last = position(player.getCurrentTime()); return last; },
      pause() { if (!destroyed && ready) { player.pauseVideo(); playing = false; stop(); emit(); } },
      seek(seconds) { if (!destroyed && ready) player.seekTo(position(seconds), true); },
      destroy,
    };
    doc.addEventListener('visibilitychange', visibility);
    signal?.addEventListener('abort', abort, { once: true });
    timeout = win.setTimeout(() => fail(new Error('O vídeo demorou para responder. Tente novamente.')), TIMEOUT);
    try {
      host.append(iframe);
      player = new YT.Player(iframe, {
        host: 'https://www.youtube-nocookie.com', videoId: media.video_id, playerVars,
        events: {
          onReady(event) {
            // A provider callback can arrive after a lesson was discarded.
            if (destroyed) { dispose(event.target); return; }
            player = event.target;
            decorate(player.getIframe());
            ready = true;
            win.clearTimeout(timeout);
            resolve(handle);
          },
          onStateChange(event) {
            if (destroyed || !ready) return;
            playing = event.data === 1;
            visibility();
            if (event.data === 2 || event.data === 0) emit();
            if (event.data === 0) onEnded?.();
          },
          onError(event) {
            const error = new Error([101, 150].includes(event.data)
              ? 'Este vídeo não permite reprodução aqui. Tente novamente ou avise o responsável pela aula.'
              : 'Não foi possível reproduzir este vídeo. Tente novamente.');
            error.code = event.data;
            fail(error);
          },
        },
      });
      if (destroyed) dispose(player);
    } catch (error) { fail(error); }
  });
}
