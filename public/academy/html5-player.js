const position = value => Number.isFinite(value) ? Math.min(86400, Math.max(0, value)) : 0;

export function createHTML5Player({ host, media, startSeconds = 0, signal, onPosition, onEnded, onError }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aula cancelada.', 'AbortError')); return; }
    const url = new URL(media.url);
    if (url.protocol !== 'https:' || url.username || url.password || !/\.(mp4|webm)$/i.test(url.pathname)) {
      throw new TypeError('Arquivo de vídeo inválido.');
    }
    const doc = host.ownerDocument, win = doc.defaultView;
    const video = doc.createElement('video');
    video.controls = true;
    video.autoplay = false;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('aria-label', host.getAttribute('aria-label') || 'Vídeo da aula');
    let destroyed = false, ready = false, playing = false, poll, timeout, last = position(startSeconds);
    const listeners = [];
    const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
    const stop = () => { win.clearInterval(poll); poll = undefined; };
    const emit = () => { if (!destroyed && ready) onPosition?.(handle.getPosition()); };
    const visibility = () => {
      stop();
      if (!destroyed && ready && playing && !video.paused && !video.ended && !doc.hidden) poll = win.setInterval(emit, 1000);
    };
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      win.clearTimeout(timeout);
      listeners.splice(0).forEach(remove => remove());
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      if (!ready) reject(new DOMException('Aula cancelada.', 'AbortError'));
    }
    function fail(error) {
      if (destroyed) return;
      reject(error);
      destroy();
      onError?.(error);
    }
    const handle = {
      getPosition() { if (!destroyed && ready) last = position(video.currentTime); return last; },
      pause() { if (!destroyed && ready) video.pause(); },
      seek(seconds) { if (!destroyed && ready) video.currentTime = position(seconds); },
      destroy,
    };
    listen(video, 'loadedmetadata', () => {
      if (ready || destroyed) return;
      try { video.currentTime = position(startSeconds); }
      catch { fail(new Error('Não foi possível retomar o vídeo. Tente novamente.')); return; }
      ready = true;
      win.clearTimeout(timeout);
      resolve(handle);
    });
    listen(video, 'playing', () => { playing = true; visibility(); });
    listen(video, 'waiting', () => { playing = false; stop(); });
    listen(video, 'pause', () => { playing = false; stop(); emit(); });
    listen(video, 'seeked', emit);
    listen(video, 'ended', () => { playing = false; stop(); emit(); onEnded?.(); });
    listen(video, 'error', () => fail(new Error('Não foi possível reproduzir este vídeo. Tente novamente.')));
    listen(doc, 'visibilitychange', visibility);
    if (signal) listen(signal, 'abort', destroy);
    timeout = win.setTimeout(() => fail(new Error('O vídeo demorou para responder. Tente novamente.')), 15000);
    try { video.src = url.href; host.append(video); } catch (error) { fail(error); }
  });
}
