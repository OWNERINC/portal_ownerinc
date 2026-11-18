// Only public registration opts into waiting. Review and password recovery
// retain immediate admission/rejection through the same active-operation cap.
function createRegistrationGate({ maxActive = 2, maxQueued = 100, waitMs = 10000 } = {}) {
  let active = 0;
  const queue = [];
  const failure = (code) => Object.assign(new Error(
    code === 'REGISTRATION_ABORTED' ? 'Registration request disconnected.' : 'Registration service is busy.',
  ), { code });

  function acquire({ wait = false, signal }) {
    if (signal?.aborted) return Promise.reject(failure('REGISTRATION_ABORTED'));
    if (active < maxActive) {
      active += 1;
      return Promise.resolve();
    }
    if (!wait || queue.length >= maxQueued) return Promise.reject(failure('REGISTRATION_BUSY'));
    return new Promise((resolve, reject) => {
      const expiresAt = Date.now() + waitMs;
      const onAbort = () => finish(failure('REGISTRATION_ABORTED'));
      const entry = { grant: () => finish(Date.now() >= expiresAt ? failure('REGISTRATION_BUSY') : null) };
      const timer = setTimeout(() => finish(failure('REGISTRATION_BUSY')), waitMs);
      function finish(error) {
        const index = queue.indexOf(entry);
        if (index === -1) return;
        queue.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else {
          active += 1;
          resolve();
        }
      }
      queue.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return async function withRegistrationOperation(operation, options = {}) {
    await acquire(options);
    try {
      // A disconnect can arrive after admission but before this continuation.
      if (options.signal?.aborted) throw failure('REGISTRATION_ABORTED');
      return await operation();
    } finally {
      active -= 1;
      while (active < maxActive && queue.length) queue[0].grant();
    }
  };
}

module.exports = { createRegistrationGate };
