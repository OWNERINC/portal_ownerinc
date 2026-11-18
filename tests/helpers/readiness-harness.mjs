import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const root = new URL('../../', import.meta.url);
export const apiRequire = createRequire(new URL('api/package.json', root));

// Load only the chosen module; transports are explicit overrides, never global
// require.cache mutations. Real policy, validation and transaction helpers run.
export function load(relative, overrides = {}) {
  const url = new URL(relative, root);
  const require = createRequire(url);
  const module = { exports: {} };
  const boundedRequire = (name) => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    const resolved = require.resolve(name);
    assert.ok(!/[\\/]api[\\/](?:db\.js|middleware[\\/]auth\.js)$/.test(resolved),
      `Transport must be explicitly overridden: ${name}`);
    return require(name);
  };
  new Function('require', 'module', 'exports', '__filename', '__dirname',
    readFileSync(url, 'utf8'))(
    boundedRequire, module, module.exports, fileURLToPath(url),
    fileURLToPath(new URL('.', url)),
  );
  return module.exports;
}

export function routes() {
  const entries = [];
  const router = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (path, ...handlers) => entries.push({ method, path, handlers });
  }
  return {
    router,
    find(method, path) {
      const entry = entries.find(item => item.method === method && item.path === path);
      assert.ok(entry, `${method} ${path} must be registered`);
      return entry.handlers[entry.handlers.length - 1];
    },
    handlers(method, path) {
      return entries.find(item => item.method === method && item.path === path).handlers;
    },
  };
}

export function response() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
  };
}

export async function deadline(promise, message, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
