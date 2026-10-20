let configuration = null;
let configured = false;
let state = 'unknown';
let localGeneration = 0;
let activeRequest = null;
let lastIdentity = null;
const STALE_RESPONSE = Symbol('stale-response');

function isValidatedIdentity(identity) {
  return identity?.validated === true && typeof identity.uid === 'string' && identity.uid.length > 0
    && Number.isSafeInteger(identity.generation);
}

function sameIdentity(first, second) {
  return first?.uid === second?.uid && first?.generation === second?.generation;
}

function currentIdentity() {
  try { return configuration?.getIdentity?.() || null; } catch (_) { return null; }
}

function isCurrent(identity, generation) {
  const current = currentIdentity();
  return generation === localGeneration && isValidatedIdentity(current)
    && current.uid === identity.uid && current.generation === identity.generation;
}

function setAvailabilityState(next) {
  if (state === next && next !== 'available') {
    hideLink();
    return;
  }
  state = next;
  const link = configuration?.document?.querySelector?.('.contents-link');
  if (!link) return;
  if (next === 'available') {
    link.hidden = false;
    return;
  }
  hideLink(link);
}

function hasUnavailableAncestor(node) {
  for (let current = node; current; current = current.parentElement || current.parentNode) {
    if (current.hidden || current.inert || current.disabled || current.hasAttribute?.('hidden')
      || current.hasAttribute?.('inert') || current.hasAttribute?.('disabled') || current.classList?.contains('hidden')
      || (current.tagName === 'MAIN' && current.hasAttribute?.('data-route-pending'))
      || current.getAttribute?.('aria-hidden') === 'true') return true;
  }
  return false;
}

function focusFallback(link, active) {
  const document = configuration?.document;
  const sidebar = active?.closest?.('.sidebar') || link.closest?.('.sidebar');
  const drawerOwnsFocus = document?.body?.classList?.contains('sidebar-open') && sidebar?.contains?.(active);
  const mobileToggle = drawerOwnsFocus ? document.querySelector('.mobile-menu-toggle') : null;
  const target = mobileToggle && !hasUnavailableAncestor(mobileToggle)
    ? mobileToggle : document.querySelector('main h1');
  if (!target || hasUnavailableAncestor(target)) return;
  if (target === mobileToggle) {
    target.focus();
    return;
  }
  const hadTabIndex = target.hasAttribute?.('tabindex');
  if (!hadTabIndex) {
    target.setAttribute('tabindex', '-1');
    const removeTemporaryTabIndex = () => {
      target.removeEventListener?.('blur', removeTemporaryTabIndex);
      if (target.getAttribute?.('tabindex') === '-1') target.removeAttribute('tabindex');
    };
    target.addEventListener?.('blur', removeTemporaryTabIndex, { once: true });
  }
  target.focus();
}

function hideLink(link = configuration?.document?.querySelector?.('.contents-link')) {
  if (!link || link.hidden) return;
  const active = configuration.document.activeElement;
  const focused = active && (active === link || link.contains?.(active) || active.closest?.('.contents-link') === link);
  link.hidden = true;
  if (focused) focusFallback(link, active);
}

export function resetContentsAvailability() {
  localGeneration += 1;
  const pending = activeRequest;
  activeRequest = null;
  pending?.controller.abort();
  setAvailabilityState('unknown');
}

async function readBoundedJSON(response, isStillCurrent) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('unavailable');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (!isStillCurrent()) return STALE_RESPONSE;
      if (done) break;
      bytes += value?.byteLength || 0;
      if (bytes > 1024) {
        await reader.cancel().catch(() => {});
        if (!isStillCurrent()) return STALE_RESPONSE;
        throw new Error('unavailable');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch (_) { /* The stream may already have released its reader. */ }
  }
  if (!isStillCurrent()) return STALE_RESPONSE;
  return JSON.parse(text);
}

async function runProbe(entry) {
  const isStillCurrent = () => isCurrent(entry.identity, entry.generation);
  try {
    const response = await configuration.request('/api/contents/availability', {
      method: 'GET',
      signal: entry.controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!isStillCurrent()) return;
    if (response?.status === 401 || response?.status === 403) {
      setAvailabilityState('denied');
      return;
    }
    if (!response || response.status !== 200 || response.ok !== true) {
      setAvailabilityState('unavailable');
      return;
    }
    const value = await readBoundedJSON(response, isStillCurrent);
    if (!isStillCurrent() || value === STALE_RESPONSE) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, 'available')
      || typeof value.available !== 'boolean') {
      setAvailabilityState('unavailable');
      return;
    }
    setAvailabilityState(value.available ? 'available' : 'empty');
  } catch (error) {
    if (!isStillCurrent()) return;
    setAvailabilityState(error?.status === 401 || error?.status === 403 ? 'denied' : 'unavailable');
  } finally {
    if (activeRequest === entry) activeRequest = null;
  }
}

export function probeContentsAvailability() {
  if (!configuration) return Promise.resolve();
  const identity = currentIdentity();
  if (!isValidatedIdentity(identity)) {
    resetContentsAvailability();
    return Promise.resolve();
  }
  if (activeRequest && sameIdentity(activeRequest.identity, identity)
    && activeRequest.generation === localGeneration) return activeRequest.promise;
  if (activeRequest) resetContentsAvailability();

  setAvailabilityState('checking');
  const entry = { identity: { uid: identity.uid, generation: identity.generation }, generation: localGeneration,
    controller: new AbortController(), promise: null };
  activeRequest = entry;
  entry.promise = runProbe(entry);
  return entry.promise;
}

function onIdentity(identity) {
  const next = identity && { uid: identity.uid || null, generation: identity.generation, validated: identity.validated === true };
  if (lastIdentity && next && sameIdentity(lastIdentity, next) && lastIdentity.validated === next.validated) return;
  lastIdentity = next;
  resetContentsAvailability();
  if (isValidatedIdentity(next)) void probeContentsAvailability();
}

function recoverIfValidated() {
  if (isValidatedIdentity(currentIdentity())) void probeContentsAvailability();
}

export function configureContentsAvailability({ request, getIdentity, subscribeIdentity, document, window } = {}) {
  if (configured) return;
  configured = true;
  configuration = { request, getIdentity, document, window };
  if (typeof subscribeIdentity === 'function') {
    subscribeIdentity(onIdentity);
  }
  document?.addEventListener?.('portal:navigated', recoverIfValidated);
  document?.addEventListener?.('visibilitychange', () => {
    if (!document.hidden && document.visibilityState !== 'hidden') recoverIfValidated();
  });
  window?.addEventListener?.('online', recoverIfValidated);
  onIdentity(currentIdentity());
}
