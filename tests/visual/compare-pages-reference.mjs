// Source-only comparison. Importing this file never loads a decoder or runs CLI.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareText } from './pages-reference-text.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nameOf = item => item.name || item.id;
const dimensions = ['x', 'y', 'width', 'height'];
const controlRegions = new Set(['primary','secondary','video','upload','confirmed','context-toolbar','style-tabs','selected-palette','custom-color','apply-style','insert-search','insert-trigger','title-field','category-field','visibility-field','back-to-editor','publish-page','typography','background','finish-editing']);
export function comparisonRegions(manifest, entry) {
  const base = entry.state.comparison?.includeDesktopRegions ? manifest.find(m => m.id === 'desktop-contextual').regions : [];
  return [...base, ...entry.regions].map(r => ({ ...r, control: r.control === true || controlRegions.has(r.id) }));
}
export function expectedAnchors(entry) {
  return entry.anchors.map(a => ({ ...a, name: a.id, tolerance: /control|trigger|finish|publish|primary/.test(a.id) ? 4 : 2 }));
}
export function compareGaps(regions, geometry) {
  const byId = id => regions.find(r => r.id === id), actual = id => geometry.find(r => r.name === id && r.visible !== false);
  const pairs = [
    ['cards-horizontal','daily-card','meetings-card','x',2],
    ['font-size','inspector-font','inspector-size','y',4], ['size-align','inspector-size','inspector-align','y',4],
    ['align-width','inspector-align','inspector-width','y',4], ['width-fill','inspector-width','inspector-fill','y',4],
    ['fill-tags','inspector-fill','inspector-tags','y',4], ['tags-icon','inspector-tags','inspector-icon','y',4],
    ...Array.from({length:6},(_,i)=>[`insert-${i}-${i+1}`,`insert-icon-${i}`,`insert-icon-${i+1}`,'y',4]),
  ];
  const measurements = [];
  for (const [name,from,to,axis,tolerance] of pairs) {
    const a=byId(from),b=byId(to); if(!a||!b)continue;
    const aa=actual(from),bb=actual(to),extent=axis==='x'?'width':'height';
    const expected=b[axis]-a[axis]-a[extent],value=aa&&bb?bb[axis]-aa[axis]-aa[extent]:null;
    measurements.push({name,from,to,axis,tolerance,expected,actual:value,delta:value===null?null:value-expected,pass:Number.isFinite(value)&&Math.abs(value-expected)<=tolerance});
  }
  return {pass:measurements.every(m=>m.pass),measurements};
}
function unique(items, label) {
  const names = items.map(nameOf);
  if (names.some(n => typeof n !== 'string' || !n) || new Set(names).size !== names.length) throw Error(`${label}: missing/duplicate anchor name`);
}
export function compareAnchors(expected, actual) {
  if (!Array.isArray(expected) || !expected.length) throw Error('Nonempty expected anchors required');
  if (!Array.isArray(actual)) throw Error('Actual anchors array required');
  unique(expected, 'expected'); unique(actual, 'actual');
  const failures = [];
  for (const e of expected) {
    const name = nameOf(e), a = actual.find(item => nameOf(item) === name), tolerance = e.tolerance ?? 2;
    if (![2, 4].includes(tolerance)) throw Error(`${name}: tolerance must be 2px frame or 4px control`);
    const keys = dimensions.filter(k => Object.hasOwn(e, k));
    if (!keys.includes('x') || !keys.includes('y') || keys.some(k => !Number.isFinite(e[k]) || (['width','height'].includes(k) && e[k] <= 0))) throw Error(`${name}: invalid expected geometry`);
    if (!a || a.visible === false) { failures.push({ name, reason: 'missing-or-hidden', expected: e, actual: a || null }); continue; }
    const deltas = {};
    for (const k of keys) {
      if (!Number.isFinite(a[k]) || (['width', 'height'].includes(k) && a[k] <= 0) || Math.abs(a[k] - e[k]) > tolerance) deltas[k] = { expected: e[k], actual: a[k] ?? null, delta: Number.isFinite(a[k]) ? a[k] - e[k] : null, tolerance };
    }
    if (Object.keys(deltas).length) failures.push({ name, reason: 'geometry', deltas });
  }
  return { pass: failures.length === 0, failures };
}

function validateImage(image) {
  if (!Number.isInteger(image?.width) || !Number.isInteger(image?.height) || image.width <= 0 || image.height <= 0 || image.data?.length !== image.width * image.height * 4) throw Error('Valid decoded RGBA image required');
}
// Pixel thresholds are deliberately absent. Exact pixels can pass automatically;
// all other local differences require inspection, even a one-channel AA difference.
// Geometry is independent: an absent DOM region cannot pass with identical pixels.
export function compareRegion({ reference, actual, region, anchors }) {
  validateImage(reference); validateImage(actual);
  if (reference.width !== actual.width || reference.height !== actual.height) throw Error('Image dimensions differ');
  if (!region || dimensions.some(k => !Number.isFinite(region[k])) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > reference.width || region.y + region.height > reference.height) throw Error('Region outside image bounds');
  if (!anchors) throw Error('Independent expected/actual DOM anchors required');
  const geometry = compareAnchors(anchors.expected, anchors.actual);
  const x = Math.floor(region.x), y = Math.floor(region.y), width = Math.ceil(region.x + region.width) - x, height = Math.ceil(region.y + region.height) - y;
  const overlay = { width, height, data: Buffer.alloc(width * height * 4) }, diff = { width, height, data: Buffer.alloc(width * height * 4) };
  let changed = 0, absolute = 0, maxChannelDelta = 0;
  const tiles = new Map();
  for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
    const from = ((y + dy) * reference.width + x + dx) * 4, to = (dy * width + dx) * 4;
    let different = false;
    for (let c = 0; c < 4; c++) {
      const a = reference.data[from + c], b = actual.data[from + c], delta = Math.abs(a - b);
      different ||= delta !== 0; absolute += delta; maxChannelDelta = Math.max(maxChannelDelta, delta);
      overlay.data[to + c] = c === 3 ? 255 : Math.round((a + b) / 2);
      diff.data[to + c] = c === 3 ? 255 : delta;
    }
    if (different) {
      changed++;
      const key = `${Math.floor(dx / 32)},${Math.floor(dy / 32)}`;
      tiles.set(key, (tiles.get(key) || 0) + 1);
    }
  }
  return { id: region.id, pass: geometry.pass && changed === 0, status: !geometry.pass ? 'FAIL_GEOMETRY' : changed ? 'REVIEW_PIXELS' : 'EXACT', geometry,
    pixels: { total: width * height, changed, changedFraction: changed / (width * height), meanAbsoluteChannelDelta: absolute / (width * height * 4), maxChannelDelta,
      worstTiles: [...tiles].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => ({ tile32: key, changed: count })) }, overlay, diff };
}

export async function loadPNG(modulePath) {
  if (!modulePath || !isAbsolute(modulePath)) throw Error('Set absolute external PNGJS_MODULE_PATH (pngjs or installed Playwright utilsBundle exporting PNG)');
  const loaded = createRequire(import.meta.url)(modulePath), PNG = loaded.PNG || loaded.default?.PNG;
  if (!PNG?.sync?.read || !PNG?.sync?.write) throw Error('PNGJS_MODULE_PATH must export PNG.sync.read/write');
  return PNG;
}
export async function validateReference(directory, entry, decode) {
  if (!directory) throw Error('PAGES_REFERENCE_DIR required');
  if (!entry.png || basename(entry.png) !== entry.png || /[\\/:]/u.test(entry.png)) throw Error('Source PNG must be a basename');
  const path = await realpath(join(directory, entry.png)), bytes = await readFile(path), hash = sha256(bytes);
  if (hash !== entry.sha256) throw Error(`${entry.id}: SHA256 mismatch at ${path}; expected ${entry.sha256}, actual ${hash}. Source must be explicitly reviewed; no automatic replacement.`);
  const image = decode(bytes); validateImage(image);
  if (image.width !== entry.width || image.height !== entry.height) throw Error(`${entry.id}: wrong source dimensions ${image.width}x${image.height}`);
  return { path, sha256: hash, image };
}
const inside = (child, parent) => { const p = relative(parent, child); return !p || (!p.startsWith(`..${sep}`) && p !== '..' && !isAbsolute(p)); };
export async function prepareOutput(output, source, repository) {
  if (!output || !source || !repository) throw Error('Output, source and repository paths required');
  const target = resolve(output), parent = await realpath(dirname(target)), effective = join(parent, basename(target));
  for (const protectedPath of [await realpath(source), await realpath(repository)]) if (inside(effective, protectedPath)) throw Error(`Output is inside protected directory: ${protectedPath}`);
  await mkdir(effective); // no recursive/reuse: existing evidence is an error
  return effective;
}

export async function compareCaptures({ manifest, sourceDirectory, output, captures, PNG }) {
  if (manifest.length !== 6 || new Set(manifest.map(e => e.id)).size !== 6) throw Error('Six distinct mandatory source entries required');
  if (captures.length !== manifest.length || new Set(captures.map(c => c.id)).size !== manifest.length) throw Error('Exactly six independent mandatory captures required');
  const resolvedOutput = await realpath(output);
  for (const protectedPath of [await realpath(sourceDirectory), await realpath(fileURLToPath(new URL('../../',import.meta.url)))]) if (inside(resolvedOutput,protectedPath)) throw Error(`Output is inside protected directory: ${protectedPath}`);
  const comparisonDirectory = join(output, 'comparison'); await mkdir(comparisonDirectory);
  const results = [];
  for (const entry of manifest) {
    const capture = captures.find(c => c.id === entry.id);
    if (!capture) throw Error(`Missing required capture ${entry.id}`);
    if (!Array.isArray(capture.geometry) || !Array.isArray(capture.anchors)) throw Error(`${entry.id}: mandatory geometry/anchor evidence missing`);
    const textChecks = compareText(entry.id, capture, comparisonRegions(manifest, entry));
    const reference = await validateReference(sourceDirectory, entry, PNG.sync.read);
    const actualPath = await realpath(capture.path), actualBytes = await readFile(actualPath), actual = PNG.sync.read(actualBytes);
    if (actual.width !== entry.width || actual.height !== entry.height) throw Error(`${entry.id}: wrong actual dimensions`);
    const regions = comparisonRegions(manifest, entry);
    const regionResults = [];
    for (const region of regions) {
      const expected = { ...region, name: region.id, tolerance: region.control ? 4 : 2 };
      const a = capture.geometry.find(g => g.name === region.id);
      const compared = compareRegion({ reference: reference.image, actual, region, anchors: { expected: [expected], actual: a ? [a] : [] } });
      const prefix = join(comparisonDirectory, `${entry.id}--${region.id}`);
      const assets = { overlay: `${prefix}-overlay.png`, diff: `${prefix}-diff.png` };
      await writeFile(assets.overlay, PNG.sync.write(compared.overlay)); await writeFile(assets.diff, PNG.sync.write(compared.diff));
      const { overlay, diff, ...metrics } = compared;
      regionResults.push({ ...metrics, expected, actual: a || null, assets });
    }
    const anchors = compareAnchors(expectedAnchors(entry), capture.anchors);
    const gaps = compareGaps(regions,capture.geometry);
    const full = compareRegion({ reference: reference.image, actual, region: { id: 'frame', x: 0, y: 0, width: entry.width, height: entry.height }, anchors: { expected: [{ name: 'viewport', x: 0, y: 0, width: entry.width, height: entry.height }], actual: [capture.viewport] } });
    const overlay = join(output, `${entry.id}-overlay.png`), diff = join(output, `${entry.id}-diff.png`);
    await writeFile(overlay, PNG.sync.write(full.overlay)); await writeFile(diff, PNG.sync.write(full.diff));
    results.push({ id: entry.id, source: { path: reference.path, sha256: reference.sha256 }, actual: { path: actualPath, sha256: sha256(actualBytes) }, overlay, diff,
      pass: full.pass && anchors.pass && gaps.pass && regionResults.every(r => r.pass) && textChecks.every(t => t.pass), anchors, gaps, regions: regionResults, textChecks,
      framePixelsDiagnosticOnly: full.pixels });
  }
  return { pass: results.every(r => r.pass), status: results.every(r => r.pass) ? 'EXACT_NOT_USER_ACCEPTANCE' : 'NOT_ACCEPTED', policy: '2px frames; 4px controls. Every missing/drifted anchor fails independently. Any local pixel difference requires review, never global-percent acceptance.', results };
}

async function main() {
  for (const key of ['PAGES_REFERENCE_DIR', 'PAGES_REFERENCE_OUTPUT', 'PNGJS_MODULE_PATH']) if (!process.env[key]) throw Error(`Set ${key}`);
  const manifest = JSON.parse(await readFile(new URL('../fixtures/pages-reference/manifest.json', import.meta.url), 'utf8'));
  const output = resolve(process.env.PAGES_REFERENCE_OUTPUT), capture = JSON.parse(await readFile(join(output, 'captures.json'), 'utf8'));
  const results = await compareCaptures({ manifest, sourceDirectory: process.env.PAGES_REFERENCE_DIR, output, captures: capture.captures, PNG: await loadPNG(process.env.PNGJS_MODULE_PATH) });
  await writeFile(join(output, 'comparison-results.json'), JSON.stringify(results, null, 2));
  if (!results.pass) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
