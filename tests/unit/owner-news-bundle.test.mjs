import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { identity, ORIGIN } from '../../scripts/import-owner-news.mjs';
import { canonicalText, bodyFingerprint, sourceIdentity, convertReferenceArticle,
  prepareBundle, inventorySources, validateBundleAsset, validateBundle, bundleHashes,
  captureReference, captureReferenceMedia, referenceMedia } from '../../scripts/lib/owner-news-bundle.mjs';
import { main } from '../../scripts/prepare-owner-news-bundle.mjs';
import * as preparationCli from '../../scripts/prepare-owner-news-bundle.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const article = (id = 'synthetic') => ({ id, status: 'published', title: 'Título sintético', category: 'Teste',
  excerpt: 'Resumo sintético.', updatedAt: '31 de ago. de 2026', blocks: [{ type: 'text', text: 'Corpo sintético.' }] });
const snapshot = { reference_sha256: 'a'.repeat(64), reference_observed_at: '2026-09-30T12:00:00Z', reference_published_count: 1,
  edition_key: '4', edition_pdf_sha256: null };
const decision = (id = 'synthetic') => ({ source_key: `reference:${id}`, canonical_key: `reference:${id}`, decision: 'include', reason: 'Revisão sintética', reviewer: 'Teste' });
const make = (articles = [article()], decisions = articles.map(a => decision(a.id)), assets = []) => prepareBundle({
  referencePayload: { store: { articles } }, sourceSnapshot: { ...snapshot, reference_published_count: articles.filter(a => a.status === 'published').length },
  editionItems: [], decisions, assets });
const approved = b => { b.items.forEach(i => { i.review_status = 'approved'; }); return b; };
async function temp(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-news-synthetic-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('normalização sugere duplicidade sem decidir fusão e conserva identidade antiga', () => {
  assert.equal(canonicalText(' Texto\n com  espaços '), 'texto com espaços');
  assert.equal(bodyFingerprint([{ type: 'paragraph', text: 'Um texto.' }]), bodyFingerprint([{ type: 'paragraph', text: 'Um  texto.' }]));
  assert.notEqual(bodyFingerprint([{ type: 'paragraph', text: 'A.' }]), bodyFingerprint([{ type: 'paragraph', text: 'B.' }]));
  assert.equal(sourceIdentity('reference:synthetic'), identity('source', 'synthetic'));
  assert.notEqual(sourceIdentity('reference:synthetic'), sourceIdentity('edition:4:synthetic'));
  const inventory = inventorySources({ referencePayload: { store: { articles: [article('a'), article('b')] } } });
  assert.deepEqual(inventory.map(i => i.candidates), [['reference:b'], ['reference:a']]);
  assert.throws(() => make([article('a'), article('b')], []), /decision/i);
});

test('conversão mantém HTML prioritário, ordem, coluna, tipografia e metadados uma vez', () => {
  const a = { ...article(), titleHtml: '<b>Título HTML</b>', excerptHtml: '<p>Resumo HTML</p>', publishedAt: '2026-08-28',
    cover: '/assets/cover.png', blocks: [
      { type: 'text', html: '<p>Primeiro.</p><p>Segundo.</p>', text: 'Não usar', layout: 'left', style: { font: 'serif' } },
      { type: 'image', image: '/assets/cover.png', url: 'https://invalid.test/a', captionHtml: '<b>Legenda</b>', credit: 'Crédito', layout: 'right' },
      { type: 'quote', html: '<p>Citação</p>', author: 'Pessoa' },
      { type: 'profile', name: 'Pessoa', role: 'Cargo', html: '<p>Perfil</p>', image: '/assets/cover.png', url: 'https://invalid.test/b', style: { font: 'sans' } },
    ] };
  const result = convertReferenceArticle(a, new Map([[`${ORIGIN}/assets/cover.png`, 'picture']]));
  assert.equal(result.title, 'Título HTML'); assert.equal(result.editorial.summary, 'Resumo HTML');
  assert.equal(result.editorial.author, ''); assert.equal(result.editorial.source_date, '2026-08-28');
  assert.deepEqual(result.blocks.map(b => b.type), ['image', 'paragraph', 'image', 'quote', 'profile']);
  assert.equal(result.blocks[1].text, 'Primeiro.\n\nSegundo.');
  assert.equal(result.blocks[1].layout, 'left'); assert.equal(result.blocks[1].typography, 'serif');
  assert.equal(result.blocks[2].caption, 'Legenda'); assert.equal(result.blocks[2].credit, 'Crédito');
  assert.equal(result.blocks[4].asset_key, 'picture'); assert.equal(result.blocks[4].typography, 'sans');
  assert.equal(result.blocks.filter(b => b.usage === 'cover').length, 1);
  assert.equal(result.sources[0].updated_at, a.updatedAt);
});

test('datas não inventadas; origem inválida e coluna longa exigem revisão explícita', () => {
  assert.equal(convertReferenceArticle(article(), new Map()).editorial.source_date, null);
  const bad = convertReferenceArticle({ ...article(), publishedAt: '2026-02-30', blocks: [{ type: 'image', image: 'https://invalid.test/a' }] }, new Map());
  assert.equal(bad.review_status, 'needs_review'); assert.ok(bad.issues.length >= 2);
  assert.throws(() => convertReferenceArticle({ ...article(), blocks: [{ type: 'text', text: 'A', layout: 'unknown' }] }, new Map()), /layout/i);
  const long = convertReferenceArticle({ ...article(), blocks: [{ type: 'text', text: 'abc '.repeat(1500), layout: 'left' }] }, new Map());
  assert.ok(long.issues.includes('column_requires_relayout')); assert.ok(long.blocks.length > 1);
  assert.ok(long.blocks.every(b => b.layout === 'left' && b.text.length <= 5000));
});

test('inline images preserve position and missing/unknown source data never silently becomes approved', () => {
  const a = { ...article(), blocks: [{ type: 'text', html: '<p>Antes</p><img src="/assets/a.png"><p>Depois</p>', layout: 'wide', style: { font: 'sans' } }] };
  const r = convertReferenceArticle(a, new Map([[`${ORIGIN}/assets/a.png`, 'a']]));
  assert.deepEqual(r.blocks.map(b => b.type), ['paragraph', 'image', 'paragraph']);
  assert.ok(r.blocks.every(b => b.layout === 'wide'));
  const missing = convertReferenceArticle(a, new Map()); assert.ok(missing.issues.includes('unresolved_media'));
  assert.ok(convertReferenceArticle({ ...article(), blocks: [{ type: 'unknown' }] }, new Map()).issues.includes('unsupported_block'));
});

test('quote inline media requires explicit curation before approval, including HTML precedence', async t => {
  const root = await temp(t);
  for (const field of ['html', 'text']) {
    const a = article();
    a.blocks = [{ type: 'quote', text: 'Fallback sintético', [field]: '<p>Antes</p><IMG src="/assets/quote.png"><p>Depois</p>', author: 'Pessoa', layout: 'left', style: { font: 'serif' } }];
    assert.equal(referenceMedia({ store: { articles: [a] } }).length, 1);
    const b = make([a]);
    assert.deepEqual(b.items[0].issues, ['quote_inline_media_requires_review']);
    assert.equal(b.items[0].blocks[0].text, 'Antes\n\nDepois');
    assert.equal(b.items[0].blocks[0].attribution, 'Pessoa');
    assert.equal(b.items[0].blocks[0].layout, 'left');
    assert.equal(b.items[0].blocks[0].typography, 'serif');
    await validateBundle(b, { root, allowPending: true });
    await assert.rejects(validateBundle(approved(b), { root, allowPending: true }), /unresolved review issues/);
    // Synthetic curator resolves the image in the source, then reconverts; no implicit approval.
    a.blocks[0][field] = '<p>Citação revisada sem mídia.</p>';
    await validateBundle(approved(make([a])), { root });
  }
});

test('CLI exposes controlled budget, pending and invalid-manifest diagnostics without private input', async t => {
  const root = await temp(t), input = path.join(root, 'synthetic-private-marker.json');
  const budget = approved(make()); budget.assets = Array.from({ length: 7 }, (_, i) => ({ key: String(i), byte_size: 50 * 1024 * 1024 }));
  for (const [content, code, detail] of [
    [JSON.stringify(budget), 'asset_budget_exceeded', '300 MiB'],
    [JSON.stringify(make()), 'review_required', 'revisão'],
    ['{"synthetic-private-marker":INVALID}', 'invalid_manifest', 'manifesto'],
    [JSON.stringify({ schema_version: 999 }), 'invalid_manifest', 'manifesto'],
  ]) {
    await fs.writeFile(input, content);
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/prepare-owner-news-bundle.mjs', '--input', input, '--check']), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, '');
      assert.ok(error.stderr.includes(`[${code}]`)); assert.ok(error.stderr.includes(detail));
      assert.ok(!error.stderr.includes(root)); assert.ok(!error.stderr.includes('synthetic-private-marker'));
      assert.ok(!error.stderr.includes('SyntaxError')); return true;
    });
  }
});

test('CLI diagnostics never echo unknown messages, paths, upstream bodies or arbitrary error codes', () => {
  for (const error of [new Error('https://private.invalid/upstream private-body'),
    Object.assign(new Error('ENOENT C:/private/editorial.json'), { code: 'SECRET_CODE' }),
    new Error('Bundle exceeds 300 MiB asset budget private-body'), null]) {
    assert.equal(preparationCli.preparationErrorMessage(error),
      'Preparação bloqueada [preparation_failed]: confira manifesto, pendências e arquivos privados.');
  }
});

test('inventário inclui rascunhos, decisões totais e exclusão parcial não apaga fonte', () => {
  const draft = { ...article('draft'), status: 'draft' };
  const decisions = [decision(), { source_key: 'reference:draft', canonical_key: null, decision: 'exclude', reason: 'Pendente fora do pacote', reviewer: 'Teste' }];
  const b = make([article(), draft], decisions);
  assert.equal(b.items.length, 1); assert.equal(b.decisions.length, 2);
  assert.deepEqual(b.source_snapshot.inventory_source_keys, ['reference:synthetic', 'reference:draft']);
  assert.throws(() => make([article()], [decision(), decision()]), /decision/i);
  assert.throws(() => make([article()], [{ ...decision(), decision: 'merge', canonical_key: 'absent' }]), /canonical/i);
});

test('pacote usa o validador CMS real, bloqueia pendências e inconsistências de decisões', async t => {
  const root = await temp(t), b = make();
  await assert.rejects(validateBundle(b, { root }), /review/i);
  await validateBundle(b, { root, allowPending: true }); await validateBundle(approved(b), { root });
  for (const mutate of [
    x => { x.items[0].editorial.summary = ''; }, x => { x.items[0].blocks = []; },
    x => { x.items[0].action = 'delete'; }, x => { x.items[0].blocks[0].layout = 'bad'; },
    x => { x.items[0].sources = []; }, x => { x.decisions.push(x.decisions[0]); },
    x => { x.items[0].blocks.push({ type: 'image', asset_key: 'missing', alt: 'Imagem' }); },
    x => { x.items[0].action = 'withdraw'; }, x => { x.items[0].editorial = null; },
  ]) { const invalid = structuredClone(b); mutate(invalid); await assert.rejects(validateBundle(invalid, { root })); }
});

test('assets recusam traversal, symlink, assinatura, MIME, tamanho e hash divergentes', async t => {
  const root = await temp(t), buffer = Buffer.from('%PDF-synthetic'); await fs.writeFile(path.join(root, 'test.pdf'), buffer);
  const asset = { key: 'pdf', relative_path: 'test.pdf', mime: 'application/pdf', byte_size: buffer.length, sha256: sha(buffer) };
  assert.equal((await validateBundleAsset(asset, { root })).sha256, sha(buffer));
  for (const change of [{ relative_path: '../test.pdf' }, { relative_path: path.join(root, 'test.pdf') },
    { relative_path: 'a/../test.pdf' }, { relative_path: 'C:\\test.pdf' }, { relative_path: 'a\\test.pdf' },
    { mime: 'image/png' }, { byte_size: buffer.length + 1 }, { sha256: '0'.repeat(64) }, { byte_size: 50 * 1024 * 1024 + 1 }]) {
    await assert.rejects(validateBundleAsset({ ...asset, ...change }, { root }));
  }
  await fs.mkdir(path.join(root, 'folder')); await fs.symlink(path.join(root, 'folder'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'folder/test.pdf'), buffer);
  await assert.rejects(validateBundleAsset({ ...asset, relative_path: 'link/test.pdf' }, { root }), /symlink/i);
  await fs.writeFile(path.join(root, 'test.pdf'), Buffer.from('not a PDF'));
  await assert.rejects(validateBundleAsset({ ...asset, byte_size: 9, sha256: sha('not a PDF') }, { root }), /PDF/i);
});

test('CLI apenas prepara, deduplica asset compartilhado, hashes excluem somente target e check não escreve', async t => {
  const root = await temp(t), buffer = Buffer.from('%PDF-synthetic'); await fs.mkdir(path.join(root, 'assets')); await fs.writeFile(path.join(root, 'assets/shared.pdf'), buffer);
  const a = { key: 'pdf', relative_path: 'assets/shared.pdf', mime: 'application/pdf', byte_size: buffer.length, sha256: sha(buffer) };
  const b = approved(make([article('a'), article('b')])); b.assets = [a];
  b.items.forEach(i => i.blocks.push({ type: 'pdf', asset_key: 'pdf', title: 'Anexo sintético' }));
  const before = bundleHashes(b), moved = structuredClone(b); moved.items[0].target = { synthetic: true };
  assert.equal(before.content_sha256, bundleHashes(moved).content_sha256); assert.notEqual(before.bundle_sha256, bundleHashes(moved).bundle_sha256);
  const input = path.join(root, 'input.json'), output = path.join(root, 'output'); await fs.writeFile(input, JSON.stringify(b));
  const report = await main(['--input', input, '--output', output]); assert.equal(report.assets, 1);
  assert.equal(report.content_sha256, before.content_sha256);
  assert.equal(report.bundle_sha256, sha(await fs.readFile(path.join(output, 'bundle.json'))));
  assert.equal((await main(['--input', input, '--check'])).bundle_sha256, sha(await fs.readFile(input)));
  assert.deepEqual((await fs.readdir(output)).sort(), ['assets', 'bundle.json', 'report.json']);
  const files = await fs.readdir(output); await main(['--input', path.join(output, 'bundle.json'), '--check']);
  assert.deepEqual(await fs.readdir(output), files);
  await assert.rejects(main(['--input', input, '--output', output]), /exist/i);
  await assert.rejects(main(['--input', input, '--output', path.resolve('public/private-test')]));
});

test('revisão aprovada não pode mascarar mídia ausente, fonte repetida, metadados ou orçamento excessivo', async t => {
  const root = await temp(t), base = approved(make());
  for (const mutate of [
    b => { b.source_snapshot.reference_sha256 = 'bad'; },
    b => { b.source_snapshot.inventory_source_keys.push('reference:unaccounted'); },
    b => { b.decisions[0].canonical_key = 'another'; },
    b => { b.decisions[0].decision = 'retain_pdf'; },
    b => { b.source_snapshot.pending_sources = [{ source_key: 'reference:synthetic', reason: 'Fora dos itens' }]; },
    b => { b.items[0].sources.push(b.items[0].sources[0]); },
    b => { b.items[0].title = '<b>Não</b>'; },
    b => { b.items[0].editorial.source_date = '2026-02-30'; },
    b => { b.items[0].editorial.summary = 'a'.repeat(1001); },
    b => { b.items[0].blocks = Array.from({ length: 100 }, () => ({ type: 'paragraph', text: '😀'.repeat(2500) })); b.items[0].blocks[0].text = 'x'.repeat(5001); },
    b => { b.items[0].blocks.push({ type: 'image', asset_id: identity('asset', 'x'), alt: 'Imagem' }); },
    b => { b.items[0].blocks.push({ type: 'video', url: 'https://invalid.test/unvalidated.mp4' }); },
    b => { b.items[0].issues = ['unresolved_media']; },
    b => { b.assets = Array.from({ length: 7 }, (_, i) => ({ key: String(i), byte_size: 50 * 1024 * 1024 })); },
    b => { b.assets = [{ key: 'same', byte_size: 1 }, { key: 'same', byte_size: 1 }]; },
  ]) { const b = structuredClone(base); mutate(b); await assert.rejects(validateBundle(b, { root })); }
  const oversized = make(); oversized.items[0].issues = ['unbreakable_paragraph'];
  oversized.items[0].blocks = [{ type: 'paragraph', text: 'a'.repeat(5 * 1024 * 1024) }];
  await assert.rejects(validateBundle(oversized, { root, allowPending: true }), /payload/i);
});

test('fusão exige decisão humana, mantém ambas procedências e nunca concatena automaticamente', async t => {
  const root = await temp(t), other = article('other'); other.blocks[0].text = 'Outro corpo.';
  const b = make([article(), other], [decision(), { ...decision('other'), decision: 'merge', canonical_key: 'reference:synthetic' }]);
  assert.equal(b.items.length, 1); assert.equal(b.items[0].sources.length, 2);
  assert.equal(b.items[0].blocks[0].text, 'Corpo sintético.');
  assert.ok(b.items[0].issues.includes('merged_body_requires_review'));
  await validateBundle(b, { root, allowPending: true });
  await assert.rejects(validateBundle(approved(b), { root }), /review/i);
});

test('PDF adiado fica explícito; retain_pdf obtido exige procedência/páginas e corpo de edição', async t => {
  const root = await temp(t), b = approved(make());
  b.source_snapshot.pending_sources = [{ source_key: 'edition:4:pdf', reason: 'Aquisição adiada' }];
  b.source_snapshot.inventory_source_keys.push('edition:4:pdf');
  b.decisions.push({ source_key: 'edition:4:pdf', canonical_key: 'edition:4:pdf', decision: 'retain_pdf', reason: 'Adiado', reviewer: 'Teste' });
  await validateBundle(b, { root });
  const invalid = structuredClone(b); delete invalid.source_snapshot.pending_sources;
  await assert.rejects(validateBundle(invalid, { root }), /canonical/i);
  const pdf = Buffer.from('%PDF-synthetic'); await fs.writeFile(path.join(root, 'edition.pdf'), pdf);
  const edition = { key: 'edition:4:pdf', title: 'Edição sintética', category: 'Teste',
    editorial: { version: 1, kind: 'edition', summary: '', author: '', source_label: 'Edição sintética', source_date: null },
    blocks: [{ type: 'pdf', asset_key: 'pdf', title: 'Edição sintética', usage: 'edition' }],
    sources: [{ kind: 'edition', edition_key: '4', pages: [1, 2] }] };
  const complete = approved(prepareBundle({ referencePayload: { store: { articles: [] } }, editionItems: [edition],
    decisions: [b.decisions.at(-1)], assets: [{ key: 'pdf', relative_path: 'edition.pdf', mime: 'application/pdf', byte_size: pdf.length, sha256: sha(pdf) }],
    sourceSnapshot: { ...snapshot, reference_published_count: 0, edition_pdf_sha256: sha(pdf) } }));
  await validateBundle(complete, { root });
  complete.items[0].sources[0].pages = [0]; await assert.rejects(validateBundle(complete, { root }), /provenance/i);
});

test('withdraw exige exclusão explícita e fotografia completa identificada; skip não escreve', async t => {
  const root = await temp(t), b = approved(make()), i = b.items[0];
  b.decisions[0] = { ...b.decisions[0], decision: 'exclude', canonical_key: null };
  i.action = 'withdraw';
  i.target = { document_id: identity('document', 'synthetic'), source_id: sourceIdentity('reference:synthetic'),
    published_revision_id: identity('revision-v1', 'synthetic'), draft_revision_id: null,
    scheduled_revision_id: null, scheduled_at: null, published_at: null, title: i.title, category: i.category };
  await validateBundle(b, { root });
  const bad = structuredClone(b); bad.items[0].target.source_id = identity('source', 'unrelated');
  await assert.rejects(validateBundle(bad, { root }), /identified/i);
  i.action = 'skip'; i.target = null; await validateBundle(b, { root });
});

test('captura usa guards reais, inventaria mídia de rascunho e limita MIME/redirect sem conteúdo nos logs', async t => {
  const root = await temp(t), a = { ...article(), cover: '/assets/cover.png' }, draft = { ...article('draft'), status: 'draft', cover: '/assets/draft.png' };
  const payload = { store: { articles: [a, draft] } }, bytes = Buffer.from(JSON.stringify(payload));
  const capture = await captureReference({ fetcher: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) });
  assert.equal(capture.sha256, sha(bytes)); assert.equal(capture.published_count, 1);
  assert.equal(referenceMedia(payload).length, 2);
  await assert.rejects(captureReference({ fetcher: async () => new Response(bytes, { headers: { 'content-type': 'text/html' } }) }), /JSON/i);
  await assert.rejects(captureReferenceMedia(payload, { root, fetcher: async () => new Response('', { status: 302, headers: { location: 'https://invalid.test/media' } }) }), /origin/i);
  await assert.rejects(captureReferenceMedia(payload, { root: path.resolve('public'), fetcher: async () => { throw new Error('must not fetch'); } }), /repository/i);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await fs.writeFile(path.join(root, 'broken.png'), png);
  await assert.rejects(validateBundleAsset({ key: 'broken', relative_path: 'broken.png', mime: 'image/png', byte_size: png.length, sha256: sha(png) }, { root }));
});

test('CLI rejeita parâmetros duplicados e entrada/saída com ancestrais symlink', async t => {
  const root = await temp(t), b = approved(make()), input = path.join(root, 'input.json');
  await fs.writeFile(input, JSON.stringify(b));
  await assert.rejects(main(['--input', input, '--check', '--check']));
  await assert.rejects(main(['--input', input, '--check', '--output', path.join(root, 'out')]));
  await fs.mkdir(path.join(root, 'real')); await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(main(['--input', input, '--output', path.join(root, 'alias/out')]), /symlink/i);
  await fs.writeFile(path.join(root, 'real/input.json'), JSON.stringify(b));
  await assert.rejects(main(['--input', path.join(root, 'alias/input.json'), '--check']), /symlink/i);
});
