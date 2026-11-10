import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const root = process.cwd();
const target = 'public/css/dashboard-home.css';
const reviewDir = 'docs/operations/agent-reviews';
const taskPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const str = { type: 'string' };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tools = [
  { name: 'inspect_dashboard', description: 'Read exact UTF-8 text, bytes and SHA-256 of the dashboard stylesheet only.', inputSchema: schema({}) },
  { name: 'replace_dashboard_snippet', description: 'Replace one unique snippet in the dashboard stylesheet if its SHA-256 still matches.', inputSchema: schema({ task_id: str, expected_sha256: str, old_text: str, new_text: str }) },
  { name: 'write_review', description: 'Append a review bound to the current dashboard stylesheet SHA-256.', inputSchema: schema({ task_id: str, expected_sha256: str, markdown: str }) },
];

async function safePath(relative, createParents = false) {
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (i === parts.length - 1) return current;
      if (!createParents) throw error;
      try { await mkdir(current); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new Error('Unsafe path');
    }
  }
  return current;
}

async function safeRead(relative, optional = false) {
  const file = await safePath(relative);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    const named = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== info.dev || named.ino !== info.ino) {
      throw new Error('Unsafe file');
    }
    return await handle.readFile();
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { if (handle) await handle.close(); }
}

async function atomicWrite(relative, bytes) {
  const file = await safePath(relative);
  const temp = path.join(path.dirname(file), `.portal-team-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = null;
    await safePath(relative);
    await rename(temp, file);
  } finally {
    if (handle) await handle.close();
    try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function withLock(action) {
  const lock = path.join(path.dirname(await safePath(target)), '.portal-team.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Dashboard lock busy');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); } finally { await rmdir(lock); }
}

function exactArgs(args, names) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== names.length || names.some(name => typeof args[name] !== 'string')) {
    throw new Error('Invalid arguments');
  }
  if (!taskPattern.test(args.task_id) || args.task_id.toLowerCase() === 'readme') throw new Error('Invalid task_id');
}

function utf8(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Dashboard stylesheet is not UTF-8');
  return text;
}

async function call(name, args) {
  if (name === 'inspect_dashboard') {
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) throw new Error('Invalid arguments');
    const bytes = await safeRead(target);
    if (bytes.length > 128 * 1024) throw new Error('Dashboard stylesheet is too large');
    const text = utf8(bytes);
    return { path: target, text, bytes_hex: bytes.toString('hex'), byte_length: bytes.length, sha256: sha256(bytes), ending: text.endsWith('\r\n') ? 'crlf' : text.endsWith('\n') ? 'lf' : 'none' };
  }
  if (name === 'replace_dashboard_snippet') {
    exactArgs(args, ['task_id', 'expected_sha256', 'old_text', 'new_text']);
    if (!/^[a-f0-9]{64}$/.test(args.expected_sha256) || !args.old_text || !args.new_text || args.old_text === args.new_text || Buffer.byteLength(args.new_text) > 8192) throw new Error('Invalid replacement');
    return withLock(async () => {
      const before = await safeRead(target);
      if (sha256(before) !== args.expected_sha256) throw new Error('Dashboard stylesheet is stale');
      const text = utf8(before);
      const at = text.indexOf(args.old_text);
      if (at < 0 || text.indexOf(args.old_text, at + 1) >= 0) throw new Error('Snippet is absent or not unique');
      if ((text.includes('\r\n') && !args.new_text.includes('\r\n')) || (!text.includes('\r\n') && args.new_text.includes('\r'))) throw new Error('Line ending mismatch');
      const next = text.slice(0, at) + args.new_text + text.slice(at + args.old_text.length);
      const nextBytes = Buffer.from(next, 'utf8');
      if (nextBytes.length > 128 * 1024 || next.endsWith('\n') !== text.endsWith('\n')) throw new Error('Invalid resulting stylesheet');
      await atomicWrite(target, nextBytes);
      const after = await safeRead(target);
      return { path: target, previous_sha256: sha256(before), current_sha256: sha256(after), start_byte: Buffer.byteLength(text.slice(0, at)), old_text: args.old_text, new_text: args.new_text };
    });
  }
  if (name === 'write_review') {
    exactArgs(args, ['task_id', 'expected_sha256', 'markdown']);
    if (!/^[a-f0-9]{64}$/.test(args.expected_sha256) || Buffer.byteLength(args.markdown) > 20 * 1024 || /^## Revisão \d+\r?$/m.test(args.markdown)) throw new Error('Invalid review');
    return withLock(async () => {
      if (sha256(await safeRead(target)) !== args.expected_sha256) throw new Error('Dashboard stylesheet hash is stale');
      const relative = `${reviewDir}/${args.task_id}.md`;
      await safePath(relative, true);
      const previous = (await safeRead(relative, true))?.toString('utf8') ?? '';
      const revision = [...previous.matchAll(/^## Revisão (\d+)$/gm)].reduce((number, match) => Math.max(number, Number(match[1])), 0) + 1;
      await atomicWrite(relative, Buffer.from(`${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}\n## Revisão ${revision}\n\n${args.markdown}\n`, 'utf8'));
      return { path: relative, revision };
    });
  }
  throw new Error('Unknown tool');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = response => process.stdout.write(`${JSON.stringify(response)}\n`);
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); continue; }
  if (!Object.hasOwn(message, 'id')) continue;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'portal-pilot', version: '1.0.0' } };
  else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') result = { tools };
  else if (message.method === 'tools/call') {
    if (!tools.some(tool => tool.name === message.params?.name)) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } }); continue; }
    try { result = { content: [{ type: 'text', text: JSON.stringify(await call(message.params.name, message.params.arguments)) }] }; }
    catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
  } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); continue; }
  send({ jsonrpc: '2.0', id: message.id, result });
}
