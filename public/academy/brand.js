const ASSET_ROOT = './assets/academy/';
const KEYS = ['symbol', 'icon-01', 'icon-02', 'icon-03', 'icon-04', 'icon-05', 'icon-06', 'logo-dark', 'logo-light'];

function parseSvg(text, key) {
  if (typeof text !== 'string' || /<\s*(script|foreignObject|image)\b|\son\w+\s*=|(?:href|src)\s*=|url\s*\(/i.test(text)) return null;
  if (typeof DOMParser !== 'function') return null;
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.localName !== 'svg' || doc.querySelector('parsererror') || svg.querySelector('script,foreignObject,image,style,use,iframe,link')) return null;
  if ([...svg.querySelectorAll('*')].some(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name) || /^(href|src|xlink:href)$/i.test(attribute.name)))) return null;
  svg.setAttribute('data-academy-asset', key);
  svg.querySelectorAll('[data-part]').forEach(part => part.setAttribute('data-motion-part', ''));
  return svg;
}

export async function loadBrandAssets({ signal } = {}) {
  const manifestResponse = await fetch(`${ASSET_ROOT}manifest.json`, { signal });
  if (!manifestResponse.ok) throw new Error('Não foi possível carregar a identidade da Academy.');
  const manifest = await manifestResponse.json();
  const assets = new Map();
  for (const key of KEYS) {
    const entry = manifest.assets?.find(asset => asset.key === key && asset.file === `${key}.svg`);
    if (!entry) throw new Error('Manifesto de identidade inválido.');
    const response = await fetch(`${ASSET_ROOT}${encodeURIComponent(entry.file)}`, { signal });
    if (!response.ok) throw new Error('Não foi possível carregar um vetor da Academy.');
    const svg = parseSvg(await response.text(), key);
    if (!svg) throw new Error('Vetor da Academy recusado por segurança.');
    assets.set(key, svg);
  }
  return assets;
}

export function createBrandIcon(assets, key, { decorative = true, label = '' } = {}) {
  const source = assets?.get(key);
  if (!source) throw new Error(`Vetor Academy desconhecido: ${key}`);
  const svg = source.cloneNode(true);
  svg.removeAttribute('id');
  svg.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  if (decorative) { svg.setAttribute('aria-hidden', 'true'); svg.removeAttribute('role'); }
  else { svg.setAttribute('role', 'img'); if (label) svg.setAttribute('aria-label', label); }
  return svg;
}
