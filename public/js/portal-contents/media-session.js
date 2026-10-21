import { validatePortalPageDTO } from './dto.js';

const MEDIA_TTL_MS = 300_000;
const MEDIA_RENEW_MS = 240_000;
const MEDIA_ISSUE_TIMEOUT_MS = 15_000;
const MEDIA_RETRY_MS = Object.freeze([5_000, 15_000, 30_000]);
const MEDIA_CLEAR_TIMEOUT_MS = 15_000;
const INVALIDATION_CHANNEL = 'ownerinc-contents-invalidation';
const INVALIDATION_STORAGE_KEY = 'ownerinc-contents-invalidation';
const AUTH_ERROR_BODY_LIMIT = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MEDIA_PATH = '/api/contents/media-session';
const ASSET_PREFIX = '/api/contents/assets/';
const STALE = Symbol('stale-contents-media');

let configuration = null;
let configured = false;
let leases = new Set();
let playingResources = new Set();
let generation = 0;
let expiresAt = 0;
let renewAt = 0;
let retryIndex = 0;
let retryAt = 0;
let timer = null;
let inFlight = null;
let clearing = false;
let clearPromise = null;
let requiresValidation = true;
let observedIdentity = null;
let channel = null;
let invalidationSequence = 0;
const seenInvalidations = new Set();

function identityIsValid(identity) {
  return identity?.validated === true && typeof identity.uid === 'string' && identity.uid.length > 0
    && Number.isSafeInteger(identity.generation);
}

function sameIdentity(left, right) {
  return identityIsValid(left) && identityIsValid(right)
    && left.uid === right.uid && left.generation === right.generation;
}

function safeError(status = 503) {
  const error = new Error('A mídia não está disponível no momento.');
  error.status = status === 401 || status === 403 ? status : 503;
  return error;
}

function abortError() {
  return new DOMException('A preparação da mídia foi cancelada.', 'AbortError');
}

function currentIdentity() {
  try { return configuration?.getIdentity?.() || null; } catch { return null; }
}

function leaseIsCurrent(lease) {
  if (!lease?.active || lease.localGeneration !== generation || clearing || requiresValidation) return false;
  if (lease.signal?.aborted) return false;
  try {
    if (typeof lease.isCurrent === 'function' && !lease.isCurrent()) return false;
  } catch { return false; }
  return sameIdentity(lease.identity, currentIdentity());
}

function hasCurrentLease(identity) {
  for (const lease of leases) {
    if (lease.localGeneration === generation && sameIdentity(lease.identity, identity) && leaseIsCurrent(lease)) return true;
  }
  return false;
}

function emit(lease, status, force = false, details = null) {
  if (!lease?.active) return;
  if (!force && lease.status === status) return;
  lease.status = status;
  try { lease.onStatus?.(status, details); } catch { /* Media status cannot interrupt the view coordinator. */ }
}

function emitCurrent(status, details = null, force = false) {
  for (const lease of leases) emit(lease, status, force, details);
}

function now() { return configuration?.now?.() ?? Date.now(); }

function isVisible() {
  const document = configuration?.document;
  return document?.visibilityState !== 'hidden' && document?.hidden !== true;
}

function canProactivelyRenew() { return isVisible() || playingResources.size > 0; }

function currentLease(identity = currentIdentity()) {
  if (!identityIsValid(identity)) return null;
  return [...leases].find(lease => leaseIsCurrent(lease) && sameIdentity(lease.identity, identity)) || null;
}

function clearScheduledTimer() {
  if (timer === null) return;
  configuration.clearTimer(timer);
  timer = null;
}

function scheduleTimer() {
  clearScheduledTimer();
  if (!configuration || !leases.size || clearing) return;
  const current = now();
  const deadlines = [];
  if (expiresAt > current) deadlines.push(expiresAt);
  if (retryAt > current && canProactivelyRenew()) deadlines.push(retryAt);
  if (renewAt > current && canProactivelyRenew()) deadlines.push(renewAt);
  if (!deadlines.length) return;
  timer = configuration.setTimer(onTimer, Math.max(0, Math.min(...deadlines) - current));
}

function expireLease() {
  if (!expiresAt || now() < expiresAt) return;
  expiresAt = 0;
  renewAt = 0;
  emitCurrent('expired');
}

function onTimer() {
  timer = null;
  if (!leases.size || clearing) return;
  expireLease();
  const owner = currentLease();
  if (!owner) { scheduleTimer(); return; }
  if (retryAt > 0 && now() >= retryAt && canProactivelyRenew()) {
    retryAt = 0;
    void startIssue(owner, { force: true, automatic: true }).catch(() => {});
    scheduleTimer();
    return;
  }
  if (renewAt > 0 && now() >= renewAt && canProactivelyRenew()) {
    void startIssue(owner, { force: true, automatic: true }).catch(() => {});
  }
  scheduleTimer();
}

function retryAfterDelay(response) {
  let value;
  try { value = response?.headers?.get?.('Retry-After'); } catch { return 0; }
  if (typeof value !== 'string' || !value.trim()) return 0;
  const seconds = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value.trim()) ? Number(value.trim()) * 1000 : NaN;
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}

function scheduleRetry(response) {
  if (!leases.size || retryIndex >= MEDIA_RETRY_MS.length) {
    retryAt = 0;
    scheduleTimer();
    return;
  }
  const backoff = MEDIA_RETRY_MS[retryIndex++];
  const serverDelay = response?.status === 429 ? retryAfterDelay(response) : 0;
  retryAt = now() + Math.max(backoff, serverDelay);
  scheduleTimer();
}

function safeRequestError(error, response) {
  const status = response?.status ?? error?.status;
  const sanitized = safeError(status);
  sanitized.retryAfter = response?.status === 429 ? retryAfterDelay(response) : 0;
  return sanitized;
}

function clearRequestTimeout(entry) {
  if (entry.timeout !== null) configuration.clearTimer(entry.timeout);
  entry.timeout = null;
}

function retireIssueIfComplete(entry) {
  if (!entry || entry.retired || !entry.processingDone || !entry.transportSettled) return;
  entry.retired = true;
  if (inFlight === entry) inFlight = null;
  entry.resolveRetirement();
}

function markTransportSettled(entry, status = null, response = null, error = null) {
  if (!entry.transportSettled) {
    entry.transportSettled = true;
    entry.transportStatus = Number.isInteger(status) ? status : null;
    entry.resolveRawSettlement({ status: entry.transportStatus });
  }
  if (response) {
    entry.response = response;
    entry.responseIssued = response.status === 204;
  }
  if (error && !entry.transportError) entry.transportError = error;
  retireIssueIfComplete(entry);
  scheduleTimer();
}

function requestIssue(entry) {
  const timeoutController = new AbortController();
  entry.controller = timeoutController;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
  entry.timeout = configuration.setTimer(() => {
    entry.timedOut = true;
    timeoutController.abort();
    rejectTimeout(safeError(503));
  }, MEDIA_ISSUE_TIMEOUT_MS);

  let request;
  try {
    request = configuration.request(MEDIA_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: timeoutController.signal,
      authErrorBodyLimit: AUTH_ERROR_BODY_LIMIT,
      onRawTransportSettled: metadata => markTransportSettled(entry, metadata?.status),
    });
  } catch (error) {
    request = Promise.reject(error);
  }
  entry.transportPromise = Promise.resolve(request).then(response => {
    markTransportSettled(entry, response?.status, response);
    return response;
  }, error => {
    markTransportSettled(entry, null, null, error);
    throw error;
  });

  return Promise.race([entry.transportPromise, timeoutPromise]).then(response => {
    clearRequestTimeout(entry);
    if (entry.generation !== generation || !sameIdentity(entry.identity, currentIdentity()) || !hasCurrentLease(entry.identity)) {
      throw STALE;
    }
    if (!response || response.status !== 204) throw safeRequestError(null, response);
    const proposedExpiry = entry.startedAt + MEDIA_TTL_MS;
    if (proposedExpiry <= now()) throw safeError(503);
    expiresAt = proposedExpiry;
    renewAt = entry.startedAt + MEDIA_RENEW_MS;
    retryIndex = 0;
    retryAt = 0;
    emitCurrent('ready');
    scheduleTimer();
    return undefined;
  }).catch(error => {
    clearRequestTimeout(entry);
    if (error === STALE || !hasCurrentLease(entry.identity) || entry.generation !== generation) throw abortError();
    const safe = error?.status === 401 || error?.status === 403
      ? safeError(error.status) : safeRequestError(error, entry.response);
    emitCurrent(safe.status === 401 || safe.status === 403 ? 'denied' : 'unavailable', { issue: entry }, true);
    if (safe.status !== 401 && safe.status !== 403) scheduleRetry(entry.response);
    throw safe;
  }).finally(() => {
    clearRequestTimeout(entry);
    entry.processingDone = true;
    retireIssueIfComplete(entry);
    scheduleTimer();
  });
}

function startIssue(lease, { force = false, automatic = false } = {}) {
  if (!leaseIsCurrent(lease)) return Promise.reject(abortError());
  const current = now();
  if (!force && expiresAt > current && renewAt > current) return Promise.resolve();
  if (clearing) return Promise.reject(safeError(503));
  if (!automatic) {
    retryAt = 0;
    retryIndex = 0;
  }
  if (inFlight) {
    const pending = inFlight;
    if (pending.generation === generation && sameIdentity(pending.identity, lease.identity)) return pending.promise;
    return pending.retirementPromise.then(() => startIssue(lease, { force, automatic }));
  }

  let resolveRawSettlement;
  const rawSettlementPromise = new Promise(resolve => { resolveRawSettlement = resolve; });
  let resolveRetirement;
  const retirementPromise = new Promise(resolve => { resolveRetirement = resolve; });
  const entry = {
    owner: lease,
    generation,
    identity: { uid: lease.identity.uid, generation: lease.identity.generation, validated: true },
    startedAt: current,
    controller: null,
    timeout: null,
    transportPromise: null,
    retirementPromise,
    resolveRetirement,
    transportSettled: false,
    transportStatus: null,
    rawSettlementPromise,
    resolveRawSettlement,
    response: null,
    responseIssued: false,
    promise: null,
    timedOut: false,
    processingDone: false,
    retired: false,
  };
  inFlight = entry;
  emitCurrent('renewing');
  entry.promise = requestIssue(entry);
  scheduleTimer();
  return entry.promise;
}

function stopLastLease() {
  clearScheduledTimer();
  expiresAt = 0;
  renewAt = 0;
  retryAt = 0;
  retryIndex = 0;
  generation += 1;
  if (inFlight) inFlight.controller?.abort();
}

function invalidateLocal({ requireIdentityValidation = true } = {}) {
  generation += 1;
  expiresAt = 0;
  renewAt = 0;
  retryAt = 0;
  retryIndex = 0;
  if (requireIdentityValidation) requiresValidation = true;
  clearScheduledTimer();
  inFlight?.controller?.abort();
  for (const lease of leases) emit(lease, 'expired', true);
}

function rememberInvalidation(id) {
  if (seenInvalidations.has(id)) return false;
  seenInvalidations.add(id);
  if (seenInvalidations.size > 128) seenInvalidations.delete(seenInvalidations.values().next().value);
  return true;
}

function parseInvalidation(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, 'generation')
    && typeof value.generation === 'string' && value.generation.length >= 8 && value.generation.length <= 160);
}

function receiveInvalidation(value) {
  if (!parseInvalidation(value) || !rememberInvalidation(value.generation)) return;
  invalidateLocal({ requireIdentityValidation: true });
  try { configuration.invalidateIdentity?.(); } catch { /* Auth revalidation will happen on the next normal check. */ }
}

function createInvalidationId() {
  invalidationSequence += 1;
  try {
    const value = globalThis.crypto?.randomUUID?.();
    if (typeof value === 'string') return value;
  } catch { /* Privacy-restricted contexts may not expose crypto. */ }
  return `contents-${Date.now().toString(36)}-${invalidationSequence.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function broadcastInvalidation() {
  const value = { generation: createInvalidationId() };
  rememberInvalidation(value.generation);
  let sent = false;
  try {
    channel?.postMessage(value);
    sent = Boolean(channel);
  } catch { /* Storage remains a narrow event-only fallback. */ }
  if (!sent) {
    try {
      const storage = configuration.window?.localStorage;
      if (storage) {
        const serialized = JSON.stringify(value);
        storage.setItem(INVALIDATION_STORAGE_KEY, serialized);
        storage.removeItem(INVALIDATION_STORAGE_KEY);
      }
    } catch { /* No persistence is required for local invalidation. */ }
  }
}

function onIdentity(identity) {
  const next = identity && {
    uid: identity.uid || null,
    generation: identity.generation,
    validated: identity.validated === true,
  };
  const previous = observedIdentity;
  const changed = !previous || previous.uid !== next?.uid || previous.generation !== next?.generation
    || previous.validated !== next?.validated;
  observedIdentity = next;
  if (changed && previous) invalidateLocal({ requireIdentityValidation: !identityIsValid(next) });
  if (identityIsValid(next)) requiresValidation = false;
  else requiresValidation = true;
  if (identityIsValid(next)) scheduleTimer();
}

function installInvalidationChannel() {
  const Broadcast = configuration.window?.BroadcastChannel || globalThis.BroadcastChannel;
  if (typeof Broadcast === 'function') {
    try {
      channel = new Broadcast(INVALIDATION_CHANNEL);
      channel.addEventListener?.('message', event => receiveInvalidation(event.data));
      if (!channel.addEventListener) channel.onmessage = event => receiveInvalidation(event.data);
    } catch { channel = null; }
  }
  if (!channel) {
    configuration.window?.addEventListener?.('storage', event => {
      if (event?.key !== INVALIDATION_STORAGE_KEY || !event.newValue) return;
      try { receiveInvalidation(JSON.parse(event.newValue)); } catch { /* Invalid event payloads fail closed. */ }
    });
  }
}

export function configureContentsMediaSession(options = {}) {
  if (configured) return;
  configured = true;
  configuration = {
    request: options.request,
    clearRequest: options.clearRequest,
    getIdentity: options.getIdentity,
    subscribeIdentity: options.subscribeIdentity,
    invalidateIdentity: options.invalidateIdentity,
    window: options.window || globalThis.window,
    document: options.document || globalThis.document,
    now: options.now || Date.now,
    setTimer: options.setTimer || setTimeout,
    clearTimer: options.clearTimer || clearTimeout,
  };
  installInvalidationChannel();
  configuration.document?.addEventListener?.('visibilitychange', () => {
    if (isVisible()) recheck('visibility');
    else scheduleTimer();
  });
  configuration.window?.addEventListener?.('online', () => recheck('online'));
  configuration.window?.addEventListener?.('focus', () => recheck('focus'));
  configuration.subscribeIdentity?.(onIdentity);
  onIdentity(currentIdentity());
}

function recheck(reason) {
  if (!leases.size || clearing || !isVisible() && playingResources.size === 0) return;
  if (!identityIsValid(currentIdentity()) || requiresValidation) return;
  const owner = currentLease();
  if (!owner) return;
  if (retryAt > 0 || !expiresAt || now() >= renewAt || now() >= expiresAt) {
    retryAt = 0;
    retryIndex = 0;
    void startIssue(owner, { force: true }).catch(() => {});
  }
  scheduleTimer();
}

export function acquireContentsMediaLease({ signal, isCurrent, onStatus } = {}) {
  const identity = currentIdentity();
  const lease = {
    active: true,
    localGeneration: generation,
    identity: identityIsValid(identity) ? { uid: identity.uid, generation: identity.generation, validated: true } : null,
    signal,
    isCurrent,
    onStatus,
    status: null,
    playingOwners: new Set(),
    ensureFresh(options = {}) { return startIssue(lease, options); },
    isPrepared() { return leaseIsCurrent(lease) && expiresAt > now(); },
    needsRenewal() { return leaseIsCurrent(lease) && (!expiresAt || now() >= renewAt || now() >= expiresAt); },
    setPlaying(value, owner = lease) {
      if (!lease.active) return;
      if (value) {
        playingResources.add(owner);
        lease.playingOwners.add(owner);
      } else {
        playingResources.delete(owner);
        lease.playingOwners.delete(owner);
      }
      scheduleTimer();
    },
    release() {
      if (!lease.active) return;
      lease.active = false;
      for (const owner of lease.playingOwners) playingResources.delete(owner);
      lease.playingOwners.clear();
      leases.delete(lease);
      signal?.removeEventListener?.('abort', onAbort);
      if (!leases.size) stopLastLease();
      else scheduleTimer();
    },
  };
  const onAbort = () => lease.release();
  leases.add(lease);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  if (signal?.aborted) lease.release();
  scheduleTimer();
  return lease;
}

function timedClearRequest() {
  const controller = new AbortController();
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timeoutId = configuration.setTimer(() => {
    controller.abort();
    rejectTimeout(safeError(503));
  }, MEDIA_CLEAR_TIMEOUT_MS);
  let raw;
  try {
    raw = configuration.clearRequest(MEDIA_PATH, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) { raw = Promise.reject(error); }
  return Promise.race([Promise.resolve(raw), timeout]).then(response => {
    if (!response || response.status !== 204) throw safeError(response?.status);
  }).catch(error => { throw safeError(error?.status); }).finally(() => configuration.clearTimer(timeoutId));
}

export function clearContentsMediaSession() {
  if (clearPromise) return clearPromise;
  const oldIssue = inFlight;
  invalidateContentsMediaSession({ broadcast: true });
  clearing = true;
  const barrier = (async () => {
    let failure = null;
    try { await timedClearRequest(); } catch (error) { failure = error; }
    if (oldIssue?.rawSettlementPromise) {
      try { await oldIssue.rawSettlementPromise; } catch { /* Settlement is metadata-only and should not reject. */ }
    } else if (oldIssue?.transportPromise) {
      try { await oldIssue.transportPromise; } catch { /* An aborted issue is settled without a cookie. */ }
    }
    // Detach only the old generation's single-flight slot so a new lease may
    // issue after the clear barrier. The entry itself retires only after both
    // its coordinator processing and raw transport have settled.
    if (inFlight === oldIssue) inFlight = null;
    // Aborting a browser fetch cannot prove the server did not complete the POST
    // after the first DELETE. Clear again after the same-tab transport settles.
    if (oldIssue) {
      try { await timedClearRequest(); } catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
    clearing = false;
    if (identityIsValid(currentIdentity())) requiresValidation = false;
    return undefined;
  })();
  clearPromise = barrier.finally(() => {
    if (clearPromise === wrapped) clearPromise = null;
    if (!clearing) scheduleTimer();
  });
  const wrapped = clearPromise;
  return wrapped;
}

export function invalidateContentsMediaSession({ broadcast = false } = {}) {
  if (!configured) return;
  invalidateLocal({ requireIdentityValidation: true });
  if (broadcast) broadcastInvalidation();
}

function pageAssetReferences(dto) {
  const references = new Set();
  if (dto.cover) references.add(dto.cover.asset_id.toLowerCase());
  for (const block of dto.content_blocks) {
    if (['image', 'video', 'pdf'].includes(block.type)) references.add(block.asset_id.toLowerCase());
    if (block.type === 'gallery') for (const image of block.images) references.add(image.asset_id.toLowerCase());
  }
  return references;
}

export function assetURL(dto, assetId) {
  validatePortalPageDTO(dto);
  if (dto.asset_scope !== 'portal-pages' || !UUID.test(dto.id) || !UUID.test(dto.revision?.id)
    || typeof assetId !== 'string' || !UUID.test(assetId)
    || !pageAssetReferences(dto).has(assetId.toLowerCase())) {
    throw new Error('Ativo de conteúdo inválido.');
  }
  return `${ASSET_PREFIX}${dto.id.toLowerCase()}/${dto.revision.id.toLowerCase()}/${assetId.toLowerCase()}`;
}
