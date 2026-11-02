const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { CHECKS, REASONS } = require('./operational-contract');
const MAX_STATE = 256 * 1024;
const MAX_PENDING = 64;
const fail = () => { throw new Error('monitor_state_unavailable'); };
const safeNumber = value => Number.isSafeInteger(value) && value >= 0;
const signature = value => value === null || (typeof value === 'string' && Object.hasOwn(REASONS, value));
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
function validateMessage(item) {
  if (!exact(item, ['id', 'createdAt', 'nextAt', 'attempts', 'inflight', 'changes'])
    || typeof item.id !== 'string' || !/^[0-9a-f]{32}$/u.test(item.id)
    || !safeNumber(item.createdAt) || !safeNumber(item.nextAt) || !safeNumber(item.attempts) || item.attempts > 1000000
    || typeof item.inflight !== 'boolean' || !Array.isArray(item.changes) || !item.changes.length || item.changes.length > CHECKS.length
    || new Set(item.changes.map(row => row?.id)).size !== item.changes.length) fail();
  for (const row of item.changes) if (!exact(row, ['id', 'reason']) || !CHECKS.includes(row.id) || !signature(row.reason)) fail();
}
function validateContents(value, legacy = false) {
  if (!exact(value, ['version', 'updatedAt', 'checks', 'outbox', 'sources', ...(legacy ? [] : ['pending', 'queueOverflow'])])
    || value.version !== (legacy ? 1 : 2) || !safeNumber(value.updatedAt)
    || !value.checks || Array.isArray(value.checks) || typeof value.checks !== 'object'
    || Object.keys(value.checks).some(id => !CHECKS.includes(id))) fail();
  if (!value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)
    || Object.keys(value.sources).some(key => !['host', 'api'].includes(key))) fail();
  for (const source of Object.values(value.sources)) if (!exact(source, ['observedAt', 'generation'])
    || !safeNumber(source.observedAt) || typeof source.generation !== 'string' || !/^[a-f0-9-]{32,64}$/u.test(source.generation)) fail();
  for (const entry of Object.values(value.checks)) {
    if (!exact(entry, ['candidate', 'count', 'current', 'delivered', ...(legacy ? [] : ['badCount'])]) || !signature(entry.candidate)
      || !signature(entry.current) || !signature(entry.delivered) || !safeNumber(entry.count) || entry.count > 2
      || (!legacy && (!safeNumber(entry.badCount) || entry.badCount > 2))) fail();
  }
  if (value.outbox !== null) validateMessage(value.outbox);
}
function validateState(value) {
  validateContents(value);
  if (!Array.isArray(value.pending) || value.pending.length > MAX_PENDING || typeof value.queueOverflow !== 'boolean') fail();
  for (const item of value.pending) {
    validateMessage(item);
    if (item.attempts !== 0 || item.inflight || item.nextAt !== item.createdAt) fail();
  }
  const messages = [...(value.outbox ? [value.outbox] : []), ...value.pending];
  if (new Set(messages.map(item => item.id)).size !== messages.length) fail();
  const projected = Object.fromEntries(Object.entries(value.checks).map(([id, entry]) => [id, entry.delivered]));
  let previousAt = 0;
  for (const item of messages) {
    if (item.createdAt < previousAt || item.createdAt > value.updatedAt) fail();
    previousAt = item.createdAt;
    for (const row of item.changes) {
      if (!Object.hasOwn(projected, row.id) || projected[row.id] === row.reason) fail();
      projected[row.id] = row.reason;
    }
  }
  if (Object.entries(value.checks).some(([id, entry]) => projected[id] !== entry.current)) fail();
  return value;
}
function upgradeState(value) {
  if (value?.version !== 1) return validateState(value);
  validateContents(value, true);
  // Preserve the old in-flight ID and reconstruct only transitions still present
  // in v1. History already lost by the old implementation cannot be recovered.
  value.version = 2; value.pending = []; value.queueOverflow = false;
  for (const entry of Object.values(value.checks)) entry.badCount = entry.candidate === null ? 0 : entry.count;
  const projected = Object.fromEntries(Object.entries(value.checks).map(([id, entry]) => [id, entry.delivered]));
  for (const row of value.outbox?.changes || []) {
    if (!Object.hasOwn(projected, row.id)) fail();
    projected[row.id] = row.reason;
  }
  const changes = Object.entries(value.checks).filter(([id, entry]) => projected[id] !== entry.current)
    .map(([id, entry]) => ({ id, reason: entry.current }));
  if (changes.length) {
    const item = { id: randomBytes(16).toString('hex'), createdAt: value.updatedAt, nextAt: value.updatedAt,
      attempts: 0, inflight: false, changes };
    if (value.outbox) value.pending.push(item); else value.outbox = item;
  }
  return validateState(value);
}
async function safeDirectory(directory, uid, privateDirectory = true) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || await fs.realpath(directory) !== directory) fail();
  let current = directory;
  while (true) {
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    if (process.platform !== 'win32') {
      const leaf = current === directory;
      // Sticky root-owned /tmp is permitted only as an ancestor of isolated fixtures.
      const stickyRoot = !leaf && info.uid === 0 && (info.mode & 0o1000);
      if (![0, uid].includes(info.uid) || (!stickyRoot && (info.mode & 0o022))
        || (leaf && (info.uid !== uid || (privateDirectory && (info.mode & 0o077))))) fail();
    }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function readProtectedJson(filename, { uid, max = MAX_STATE, privateFile = true }) {
  await safeDirectory(path.dirname(filename), uid, privateFile);
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (process.platform !== 'win32' && (before.uid !== uid || (before.mode & (privateFile ? 0o077 : 0o022))))
    || before.size > max) fail();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail();
    const bytes = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > max) fail();
    const raw = bytes.subarray(0, bytesRead).toString('utf8');
    const value = JSON.parse(raw);
    if (privateFile && raw !== `${JSON.stringify(value)}\n`) fail();
    return value;
  } finally { await handle.close(); }
}
async function openState(directory) {
  const uid = process.getuid?.() ?? 0;
  await safeDirectory(directory, uid);
  // systemd/flock owns the cross-process lock. This create-exclusive guard also
  // protects direct callers. A crash leaves a visible lock; systemd uses flock
  // instead (externalLock) so no unsafe PID-based lock stealing is necessary.
  const filename = path.join(directory, 'state.json');
  const load = async () => {
    try { return upgradeState(await readProtectedJson(filename, { uid })); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('monitor_state_unavailable');
      return { version: 2, updatedAt: 0, checks: {}, sources: {}, outbox: null, pending: [], queueOverflow: false };
    }
  };
  const save = async value => {
    validateState(value);
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > MAX_STATE) fail();
    await safeDirectory(directory, uid);
    const temporary = path.join(directory, `.state-${randomBytes(16).toString('hex')}`);
    let handle;
    try {
      handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      try { await readProtectedJson(filename, { uid }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(temporary, filename);
      if (process.platform !== 'win32') { const parent = await fs.open(directory, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); } }
    } catch { fail(); }
    finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  };
  return { load, save };
}
async function withStateLock(directory, work) {
  await safeDirectory(directory, process.getuid?.() ?? 0);
  const lock = path.join(directory, 'run.lock');
  const handle = await fs.open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try { return await work(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
module.exports = { openState, readProtectedJson, safeDirectory, validateState, withStateLock, MAX_PENDING };
