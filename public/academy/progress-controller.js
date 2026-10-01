// Pass the original fetchAPI, never page.bindAPI: background saves do not own page busy state.
export function createProgressController({ lessonId, initial, request, signal,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, onStatus = () => {} }) {
  let confirmed = { ...initial };
  let position = initial.position_seconds;
  let completion = null;
  let disposed = false;
  let stopped = null;
  let timer = null;
  let flight = null;
  let failures = 0;
  let retryAt = 0;
  const local = new AbortController();
  const dirty = () => position !== confirmed.position_seconds || completion;
  const publish = (status, detail) => { if (!disposed) onStatus(status, detail); };
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  function schedule(delay) {
    if (disposed || stopped || timer !== null) return;
    timer = setTimer(() => { timer = null; flush().catch(() => {}); }, delay);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelTimer();
    local.abort();
    completion?.reject(abortError());
    completion = null;
    signal?.removeEventListener('abort', dispose);
  }
  const abortError = () => new DOMException('Sincronização cancelada.', 'AbortError');
  async function drain() {
    while (dirty() && !disposed && !stopped) {
      const sent = { media_version: confirmed.media_version, expected_version: confirmed.version,
        position_seconds: position, ...(completion ? { completed: true } : {}) };
      publish('saving');
      try {
        const result = await request(`/api/academy/lessons/${lessonId}/progress`, {
          method: 'PUT', body: JSON.stringify(sent), signal: local.signal,
        });
        if (disposed) throw abortError();
        confirmed = result;
        if (sent.completed) {
          // Confirm the explicit action here, independently of later position writes.
          completion?.resolve(result);
          completion = null;
        }
        failures = 0;
        retryAt = 0;
        publish(dirty() ? 'pending' : 'saved', confirmed);
      } catch (error) {
        if (disposed) throw abortError();
        // A failed explicit action must be retried explicitly by its button.
        completion?.reject(error);
        completion = null;
        if (error.status === 409) {
          stopped = error;
          publish('conflict', error);
        } else if ((error.status >= 400 && error.status < 500 && error.status !== 429) || error.name === 'AbortError') {
          stopped = error;
          publish('unavailable', error);
        } else {
          const delay = error.status === 429 ? 60000 : [5000, 15000, 30000][Math.min(failures++, 2)];
          retryAt = now() + delay;
          publish('pending', error);
          if (dirty()) schedule(delay);
        }
        throw error;
      }
    }
    return confirmed;
  }
  function flush() {
    if (disposed) return Promise.reject(abortError());
    if (stopped) return Promise.reject(stopped);
    if (flight) return flight.then(() => dirty() ? flush() : confirmed);
    if (retryAt > now()) {
      schedule(retryAt - now());
      return Promise.reject(new Error('Aguardando nova tentativa de sincronização.'));
    }
    cancelTimer();
    if (!dirty()) return Promise.resolve(confirmed);
    flight = drain().finally(() => {
      flight = null;
      if (dirty()) schedule(Math.max(0, retryAt - now()));
    });
    return flight;
  }
  function record(seconds) {
    if (disposed || stopped || !Number.isFinite(seconds)) return;
    position = Math.max(0, Math.min(86400, Math.floor(seconds)));
    if (dirty()) {
      publish('pending');
      if (!flight) schedule(Math.max(30000, retryAt - now()));
    }
  }
  function complete() {
    if (disposed || stopped) return flush();
    if (retryAt > now()) return flush();
    if (completion) return completion.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    completion = { promise, resolve, reject };
    // The drain continues for positions, but its later failure cannot undo this action.
    flush().catch(error => {
      if (completion?.promise === promise) {
        completion = null;
        reject(error);
      }
    });
    return promise;
  }
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  return { record, flush, complete, dispose };
}
