// Local visual preview. Authentication/data substitutes exist only in this
// loopback server; it cannot forward requests or write production data.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { fixtureData, user } from './conecta-fixtures.mjs';

const root = process.env.VISUAL_PUBLIC_ROOT ? resolve(process.env.VISUAL_PUBLIC_ROOT) : fileURLToPath(new URL('../../public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const auth = `
export const fixtureUser = ${JSON.stringify(user)};
export class APIError extends Error { constructor(message,status) { super(message); this.status=status; } }
export async function authenticatedFetch(path, options={}) { return fetch(path, options); }
export async function fetchAPIPage(path, options={}) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) throw new APIError((await response.json()).error, response.status);
  const data = await response.json(); return { data, total: Number(response.headers.get('X-Total-Count') || 0) };
}
export async function fetchAPI(path, options={}) { return (await fetchAPIPage(path, options)).data; }
export async function fetchAPIAsset() { throw new APIError('Prévia sem assets privados',404); }
export async function getCurrentUserDoc() {
  Object.assign(document.documentElement.dataset, {authState:'ready', portalRole:'admin', autocardAccess:'true', posCardsAccess:'true'});
  return fixtureUser;
}
export const requireAuth = getCurrentUserDoc;
export function getCachedUserSnapshot() { return fixtureUser; }
export function can() { return true; }
export function showToast(message) { const node=document.getElementById('toast'); if(node) {node.textContent=message; node.classList.remove('hidden');} }
export async function logout() { location.href='/login.html'; }
export async function updateAuthDisplayName() {}
`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, type, body, headers={}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers }); res.end(body); };
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'application/json', JSON.stringify({ error: 'Prévia visual: gravações indisponíveis.' }));
    if (url.pathname === '/js/auth.js') return send(200, types['.js'], auth);
    if (url.pathname === '/js/firebase-config.js') return send(200, types['.js'], `export const auth = { currentUser: location.pathname === '/login.html' ? null : ${JSON.stringify(user)}, async authStateReady() {} };`);
    if (url.pathname === '/__fixture/firebase-sdk.js') return send(200, types['.js'], "export async function signOut() {} export async function signInWithEmailAndPassword() { throw new Error('Prévia visual: autenticação real indisponível.'); }");
    if (url.pathname.startsWith('/api/')) {
      const data = fixtureData(url);
      return send(data === undefined ? 404 : 200, types['.json'], JSON.stringify(data ?? { error: 'Fixture não definida.' }), { 'X-Total-Count': String(Array.isArray(data) ? data.length : 0) });
    }
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/dashboard.html' : url.pathname)}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return send(403, 'text/plain', 'Forbidden');
    let body = await readFile(path);
    if (extname(path) === '.html') body = body.toString().replace('</body>', '<div style="position:fixed;bottom:0;left:0;right:0;z-index:1000;padding:3px 8px;background:#2A275E;color:#FFFEFB;font:11px sans-serif;text-align:center;pointer-events:none">PRÉVIA LOCAL · dados demonstrativos · autenticação e gravações simuladas</div></body>');
    if (url.pathname === '/js/login.js') body = body.toString().replace('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js', '/__fixture/firebase-sdk.js');
    send(200, types[extname(path)] || 'application/octet-stream', body);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Preview resource unavailable'); }
});
server.listen(Number(process.env.PORT || 4178), '127.0.0.1', () => console.log(`Conecta visual fixtures: http://127.0.0.1:${server.address().port}`));
