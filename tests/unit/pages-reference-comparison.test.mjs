import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { compareAnchors, compareRegion, compareCaptures, compareGaps, validateReference, prepareOutput } from '../visual/compare-pages-reference.mjs';
import { expectedText, compareText, assertTextCoverage } from '../visual/pages-reference-text.mjs';

function textEvidence(id) {
  const checks=expectedText(id);
  const rows=checks.map(t=>({...t,regions:[t.region],visible:t.exposure==='visible',excluded:t.exposure==='visible'?[]:['panel-covered'],
    paintLayers:t.occluderRegion?[{kind:'panel',alpha:1,regions:[t.occluderRegion]}]:t.backdropAlpha===undefined?[]:[{kind:'backdrop',alpha:t.backdropAlpha,regions:[]}],x:81,y:11,width:5,height:5}));
  return {textChecks:checks.map(t=>({...t,pass:true})),text:rows.filter(t=>t.visible),underlyingDOM:rows};
}
test('source-specific transparent-panel exposure and review scrim stay visible; hiding any exposed phrase fails',()=>{
  const visible={
    'desktop-style':['header','inspector','meetings-card','faq','audio-placeholder'],
    'desktop-insert':['header','inspector','meetings-card','faq','audio-placeholder'],
    'desktop-review':['header','inspector','daily-card','faq'],
  };
  for(const [id,exposed]of Object.entries(visible)){
    const checks=expectedText(id),regions=checks.map(t=>({...region,id:t.region}));
    assert.deepEqual(checks.slice(0,8).filter(t=>t.exposure==='visible').map(t=>t.region),exposed);
    assert.ok(checks.slice(0,8).every(t=>t.reason.startsWith('reference-')),'each source requirement has its own paint rationale');
    for(const name of exposed){
      const c=textEvidence(id);assert.ok(compareText(id,c,regions).every(t=>t.pass));
      c.text.find(t=>t.region===name).visible=false;
      c.textChecks.find(t=>t.region===name).exposure='underlyingDOM';
      assert.equal(compareText(id,c,regions).find(t=>t.region===name).pass,false,`${id}/${name} cannot be downgraded by capture`);
    }
    const c=textEvidence(id),covered=c.underlyingDOM.find(t=>t.exposure==='underlyingDOM');
    covered.paintLayers=[];
    assert.equal(compareText(id,c,regions).find(t=>t.region===covered.region).pass,false,'underlying must have actual opaque-panel coverage evidence');
  }
  const c=textEvidence('desktop-review'),regions=expectedText('desktop-review').map(t=>({...region,id:t.region}));
  c.text.find(t=>t.region==='header').paintLayers[0].alpha=0.9;
  assert.equal(compareText('desktop-review',c,regions).find(t=>t.region==='header').pass,false,'review uses the source 40% scrim, not arbitrary translucency');
});
test('independent text contract rejects omitted, duplicate, wrong-region and unknown checks',()=>{
  const id='mobile-content',checks=expectedText(id);
  for(const bad of [[],checks.slice(1),[...checks,checks[0]],[...checks.slice(1),checks[1]],checks.map((c,i)=>i?c:{...c,region:'other'})])assert.throws(()=>assertTextCoverage(id,bad),/coverage/);
});
test('forged success and wrong selected values cannot borrow label/options/another control text',()=>{
  const id='mobile-content',c=textEvidence(id),regions=expectedText(id).map(t=>({...region,id:t.region}));
  assert.ok(compareText(id,c,regions).every(t=>t.pass));
  const selection=c.text.find(t=>t.region==='typography');selection.text='Manrope · 15 px';
  c.text.push({...selection,kind:'text',text:'Manrope · 16 px'}, {...selection,regions:['background'],text:'Manrope · 16 px'});
  assert.equal(compareText(id,c,regions).find(t=>t.region==='typography').pass,false);
  c.text=c.text.filter(t=>t.region!=='header');
  assert.equal(compareText(id,c,regions).find(t=>t.region==='header').pass,false);
});
test('hidden, closed, clipped or occluded-only text is never visible proof',()=>{
  const id='mobile-content',regions=expectedText(id).map(t=>({...region,id:t.region}));
  for(const reason of ['closed-details','ancestor-clipped','occluded']){
    const c=textEvidence(id);c.text[0]={...c.text[0],visible:false,excluded:[reason]};
    assert.equal(compareText(id,c,regions)[0].pass,false);
    c.text.shift();assert.equal(compareText(id,c,regions)[0].pass,false);
  }
});

const image = (width = 100, height = 100) => ({ width, height, data: Buffer.alloc(width * height * 4, 255) });
function paint(img, x, y, width, height, color = 0) {
  for (let dy = y; dy < y + height; dy++) for (let dx = x; dx < x + width; dx++) {
    const i = (dy * img.width + dx) * 4;
    img.data.fill(color, i, i + 3);
  }
  return img;
}
const expected = [{ name: 'inspector', x: 80, y: 10, width: 10, height: 20, tolerance: 2 }];
const region = { id: 'inspector', x: 80, y: 10, width: 15, height: 20 };

test('local gaps fail on compression and missing controls, independently of global frame similarity', () => {
  const regions=[{id:'insert-icon-0',x:48,y:274,width:16,height:16},{id:'insert-icon-1',x:48,y:338,width:16,height:16}];
  const actual=regions.map(r=>({...r,name:r.id,visible:true}));
  assert.equal(compareGaps(regions,actual).pass,true);
  actual[1].y-=6;assert.equal(compareGaps(regions,actual).pass,false);
  actual.pop();assert.equal(compareGaps(regions,actual).pass,false);
});

test('5px inspector drift fails even with 98% of the frame identical', () => {
  const result = compareAnchors([{ name: 'inspector', x: 1320, y: 128, tolerance: 2 }], [{ name: 'inspector', x: 1325, y: 128 }]);
  assert.equal(result.pass, false); assert.equal(result.failures[0].name, 'inspector');
  const reference = paint(image(), 80, 10, 5, 20), actual = paint(image(), 85, 10, 5, 20);
  const compared = compareRegion({ reference, actual, region, anchors: { expected, actual: [{ ...expected[0], x: 85 }] } });
  assert.equal(compared.pass, false); assert.equal(compared.status, 'FAIL_GEOMETRY');
});

test('missing region and missing control fail, including pixel-identical frames', () => {
  assert.equal(compareAnchors(expected, []).pass, false);
  assert.equal(compareRegion({ reference: image(), actual: image(), region, anchors: { expected, actual: [] } }).pass, false);
  const reference = paint(image(), 80, 10, 5, 20);
  const result = compareRegion({ reference, actual: image(), region, anchors: { expected, actual: expected } });
  assert.equal(result.pass, false); assert.equal(result.pixels.changed, 100);
  assert.equal(result.status, 'REVIEW_PIXELS');
});

test('2px frames / 4px controls are inclusive; missing, nonfinite or collapsed actuals fail', () => {
  for (const tolerance of [2, 4]) {
    const e = [{ name: 'control', x: 10, y: 10, width: 20, height: 20, tolerance }];
    assert.equal(compareAnchors(e, [{ ...e[0], x: 10 + tolerance }]).pass, true);
    assert.equal(compareAnchors(e, [{ ...e[0], x: 10 + tolerance + .01 }]).pass, false);
    for (const patch of [{ x: NaN }, { width: 0 }, { visible: false }, { y: undefined }]) assert.equal(compareAnchors(e, [{ ...e[0], ...patch }]).pass, false);
  }
  assert.throws(() => compareAnchors([], []), /expected/i);
  assert.throws(() => compareAnchors([expected[0], expected[0]], expected), /duplicate/i);
  assert.throws(() => compareAnchors(expected, [expected[0], expected[0]]), /duplicate/i);
});

test('exact local pixels and geometry pass; a one-pixel glyph change is review, not accepted antialiasing', () => {
  const reference = image(), actual = image();
  let result = compareRegion({ reference, actual, region, anchors: { expected, actual: expected } });
  assert.equal(result.pass, true); assert.equal(result.status, 'EXACT');
  paint(actual, 82, 12, 1, 1, 254);
  result = compareRegion({ reference, actual, region, anchors: { expected, actual: expected } });
  assert.equal(result.pass, false); assert.equal(result.pixels.changed, 1);
  assert.equal(result.pixels.maxChannelDelta, 1); assert.equal(result.overlay.width, 15);
  assert.equal(result.diff.data[(2 * 15 + 2) * 4], 1);
});

test('wrong image dimensions, invalid crops, malformed buffers and absent anchors are errors', () => {
  const args = { reference: image(), actual: image(), region, anchors: { expected, actual: expected } };
  assert.throws(() => compareRegion({ ...args, actual: image(99) }), /dimensions/i);
  assert.throws(() => compareRegion({ ...args, region: { ...region, x: 99 } }), /bounds/i);
  assert.throws(() => compareRegion({ ...args, reference: { ...image(), data: Buffer.alloc(4) } }), /RGBA/i);
  assert.throws(() => compareRegion({ ...args, anchors: undefined }), /anchors/i);
});

test('mandatory file, SHA and decoded dimensions fail hard, never skip or acknowledge automatically', async () => {
  await mkdir(join(tmpdir(), 'opencode'), { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), 'opencode', 'comparison-negative-'));
  try {
    const bytes = Buffer.from('decoder fixture'), entry = { id: 'test', png: 'test.png', width: 100, height: 100, sha256: createHash('sha256').update(bytes).digest('hex') };
    await assert.rejects(validateReference(dir, entry, () => image()), /ENOENT/);
    await writeFile(join(dir, entry.png), bytes);
    await assert.rejects(validateReference(dir, { ...entry, sha256: '0'.repeat(64) }, () => image()), /SHA256/);
    await assert.rejects(validateReference(dir, entry, () => image(99)), /dimensions/i);
    await assert.rejects(validateReference(dir, { ...entry, png: '../test.png' }, () => image()), /basename/i);
    assert.equal((await validateReference(dir, entry, () => image())).sha256, entry.sha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('output must be new and outside source/repository; old evidence cannot be overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode', 'comparison-output-'));
  try {
    const source = join(dir, 'source'), repo = join(dir, 'repo');
    await mkdir(source); await mkdir(repo);
    await assert.rejects(prepareOutput(source, source, repo), /protected/i);
    await assert.rejects(prepareOutput(join(repo, 'screenshots'), source, repo), /protected/i);
    const out = join(dir, 'new'); await prepareOutput(out, source, repo);
    await assert.rejects(prepareOutput(out, source, repo), /EEXIST/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('six-board comparison uses source geometry, rejects incomplete sets, and cannot waive a missing inspector', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode', 'comparison-six-'));
  try {
    const sourceDirectory = join(dir, 'source'), output = join(dir, 'output'); await mkdir(sourceDirectory); await mkdir(output);
    const bytes = Buffer.from('codec-is-injected-not-a-golden'), hash = createHash('sha256').update(bytes).digest('hex');
    const manifest = ['editable-buttons','desktop-contextual','desktop-style','desktop-insert','desktop-review','mobile-content'].map((id, i) => ({ id, png: `source-${i}.png`, width: 100, height: 100, sha256: hash, state: {}, regions: [...new Set(['inspector',...expectedText(id).map(t=>t.region)])].map(id=>({...region,id})), anchors: expected.map(e => ({ ...e, id: e.name })) }));
    const captures = [];
    for (const entry of manifest) {
      await writeFile(join(sourceDirectory, entry.png), bytes);
      const path = join(output, `${entry.id}.png`); await writeFile(path, bytes);
      captures.push({ id: entry.id, path, geometry: entry.regions.map(r=>({...r,name:r.id})), anchors: expected,
        viewport: { name: 'viewport', x: 0, y: 0, width: 100, height: 100 }, ...textEvidence(entry.id) });
    }
    const PNG = { sync: { read: () => image(), write: () => Buffer.from('test-encoded-artifact') } };
    await assert.rejects(compareCaptures({ manifest, sourceDirectory, output, captures: captures.slice(1), PNG }), /six independent/i);
    // Even a forged capture-side contract may not override source regions/anchors.
    captures[0].geometry = []; captures[0].regions = []; captures[0].expectedAnchors = [];
    captures[1].text=[]; // capture claims success, but the inventory is empty
    const result = await compareCaptures({ manifest, sourceDirectory, output, captures, PNG });
    assert.equal(result.pass, false); assert.equal(result.results.length, 6);
    assert.equal(result.results[0].regions[0].status, 'FAIL_GEOMETRY');
    assert.equal(result.results[0].framePixelsDiagnosticOnly.changed, 0);
    assert.equal(result.results[1].pass, false);
    assert.ok(result.results[1].textChecks.every(t=>!t.pass));
    assert.equal(result.results[2].pass, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
