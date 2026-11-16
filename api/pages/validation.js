// Deliberately independent of the browser editor and ProseMirror packages.
const { uuid } = require('../route-utils');
const { createRichTextValidator } = require('./validation-common');
const { validateV3 } = require('./validation-v3');

class PagesError extends Error {
  constructor(status, reason, message = reason) { super(message); this.status = status; this.reason = reason; }
}
const fail = (reason = 'invalid_document') => { throw new PagesError(400, reason); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail();
}
function text(value, max) { if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) fail(); }
function safeLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) {
    try { const url = new URL(value, 'https://pages.invalid'); return url.origin === 'https://pages.invalid'; } catch { return false; }
  }
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}

function validateDocument(input, { publishing = false } = {}) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { fail(); }
  if (bytes > 1024 * 1024) throw new PagesError(413, 'document_too_large');
  if (input?.schema_version === 3) return validateV3(input, { publishing, PagesError, safeLink });
  keys(input, ['schema_version', 'template', 'metadata', 'presentation', 'sections']);
  if (![1, 2].includes(input.schema_version)) fail();
  const v2 = input.schema_version === 2;
  keys(input.template, ['id', 'version']);
  if (!(input.template.id === 'comunicado' && input.template.version === (v2 ? 2 : 1))
    && !(v2 && input.template.id === 'owner-news' && input.template.version === 1)) fail();
  keys(input.metadata, ['title', 'summary', 'tags', 'audience']);
  const meta = input.metadata;
  text(meta.title, 200); text(meta.summary, 1000);
  if (!Array.isArray(meta.tags) || meta.tags.length > 20) fail();
  meta.tags.forEach(tag => { text(tag, 40); if (!tag.trim()) fail(); });
  if (new Set(meta.tags).size !== meta.tags.length) fail();
  keys(meta.audience, ['type', 'job_title_ids']);
  const cargos = meta.audience.job_title_ids;
  if (meta.audience.type !== 'job_titles' || !Array.isArray(cargos) || cargos.length > 100 || !cargos.every(uuid)
    || new Set(cargos.map(id => id.toLowerCase())).size !== cargos.length) fail();
  keys(input.presentation, ['theme', 'font', 'text_scale']);
  if (input.presentation.theme !== 'conecta' || input.presentation.font !== 'manrope' || input.presentation.text_scale !== 'standard') fail();
  const ids = new Set(), media = new Set(), mediaRefs = [], destinations = [];
  let rows = 0, blocks = 0, chars = meta.title.length + meta.summary.length + meta.tags.reduce((sum, tag) => sum + tag.length, 0), meaningful = false, nodes = 0;
  function id(value) { if (!uuid(value) || ids.has(value.toLowerCase())) fail(); ids.add(value.toLowerCase()); }
  function style(value) {
    if (value === undefined) return;
    if (!v2) fail();
    keys(value, ['align', 'scale', 'palette', 'font']);
    if (!['start','center','end'].includes(value.align) || !['small','standard','large'].includes(value.scale)
      || !['neutral','brand','warm'].includes(value.palette) || !['manrope','source-serif-4','oswald'].includes(value.font)) fail();
  }
  function destination(value) {
    keys(value, ['type', 'value']);
    if (value.type === 'section') { if (!uuid(value.value)) fail(); destinations.push(value.value.toLowerCase()); }
    else if (value.type !== 'url' || !safeLink(value.value)) fail();
  }
  function reference(block, kind) {
    if (!uuid(block.media_id)) fail();
    const id = block.media_id.toLowerCase(); media.add(id); mediaRefs.push({ id, kind });
  }
  function marks(value) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 4) fail();
    const seen = new Set();
    for (const mark of value) {
      keys(mark, ['type'], ['attrs']);
      if (seen.has(mark.type)) fail(); seen.add(mark.type);
      if (mark.type === 'link') { keys(mark.attrs, ['href']); if (!safeLink(mark.attrs.href)) fail(); }
      else if (!['strong', 'em', 'underline'].includes(mark.type) || mark.attrs !== undefined) fail();
    }
  }
  const pm = createRichTextValidator({ fail, object, keys, text, marks,
    countNode() { if (++nodes > 20000) fail(); },
    onText(value) { chars += value.length; if (value.trim()) meaningful = true; },
  });
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > (v2 ? 20 : 1)) fail();
  for (const section of input.sections) {
    keys(section, ['id', 'label', 'rows']); id(section.id); text(section.label, 200); chars += section.label.length;
    if (!Array.isArray(section.rows) || !section.rows.length) fail();
    for (const row of section.rows) {
      if (++rows > 100) fail(); keys(row, ['id', 'layout', 'columns']); id(row.id);
      if (!['single', ...(v2 ? ['two_equal'] : [])].includes(row.layout) || !Array.isArray(row.columns) || row.columns.length !== (row.layout === 'single' ? 1 : 2)) fail();
      for (const column of row.columns) {
        keys(column, ['id', 'blocks']); id(column.id);
        if (!Array.isArray(column.blocks)) fail();
        for (const block of column.blocks) {
          if (++blocks > 100 || !object(block)) fail(); id(block.id); style(block.style);
          const optionalStyle = v2 ? ['style'] : [];
          if (block.type === 'rich_text' || (v2 && block.type === 'callout')) {
            keys(block, ['id', 'type', 'content', ...(block.type === 'callout' ? ['tone','icon'] : [])], optionalStyle);
            if (block.type === 'callout' && (!['info','attention','success'].includes(block.tone) || !['none','info','alert','check'].includes(block.icon))) fail();
            if (block.content?.type !== 'doc') fail(); pm(block.content);
          }
          else if (block.type === 'image' || (v2 && block.type === 'gif')) {
            keys(block, ['id', 'type', 'media_id', 'alt', 'caption', 'credit'], optionalStyle);
            reference(block, block.type);
            text(block.alt, 300); text(block.caption, 1000); text(block.credit, 300);
            chars += block.alt.length + block.caption.length + block.credit.length;
            if (publishing && !block.alt.trim()) fail('image_alt_required');
          } else if (v2 && ['audio','video'].includes(block.type)) {
            keys(block, ['id','type','media_id','title','transcript', ...(block.type === 'video' ? ['captions'] : [])], optionalStyle); reference(block, block.type);
            text(block.title, 200); text(block.transcript, 20000); chars += block.title.length + block.transcript.length;
            const captions = block.captions || [];
            if (!Array.isArray(captions) || captions.length > 500) fail();
            let end = 0;
            for (const cue of captions) {
              keys(cue, ['start_ms','end_ms','text']); text(cue.text, 1000); chars += cue.text.length;
              if (!Number.isSafeInteger(cue.start_ms) || !Number.isSafeInteger(cue.end_ms) || cue.start_ms < end || cue.end_ms <= cue.start_ms || cue.end_ms > 120000 || /[<>]|-->/u.test(cue.text)) fail();
              end = cue.end_ms;
            }
            if (publishing && (!block.transcript.trim() || (block.type === 'video' && !captions.length))) fail('media_accessibility_required');
          } else if (v2 && block.type === 'button') {
            keys(block, ['id','type','label','preset','destination'], optionalStyle); text(block.label, 120); chars += block.label.length;
            if (!block.label.trim() || !['primary','secondary','text'].includes(block.preset)) fail(); destination(block.destination);
          } else if (v2 && block.type === 'divider') keys(block, ['id','type'], optionalStyle);
          else fail();
        }
      }
    }
  }
  const sections = new Set(input.sections.map(section => section.id.toLowerCase()));
  if (destinations.some(target => !sections.has(target))) fail('invalid_section_target');
  if (chars > 100000) fail();
  if (publishing && (!meta.title.trim() || !meaningful || !cargos.length)) fail('publication_incomplete');
  // Canonical lower-case UUIDs make relational projections exact, not aliases.
  const document = JSON.parse(JSON.stringify(input));
  document.metadata.audience.job_title_ids = cargos.map(value => value.toLowerCase());
  for (const section of document.sections) {
    section.id = section.id.toLowerCase();
    for (const row of section.rows) { row.id = row.id.toLowerCase(); for (const col of row.columns) {
      col.id = col.id.toLowerCase(); for (const block of col.blocks) { block.id = block.id.toLowerCase(); if (block.media_id) block.media_id = block.media_id.toLowerCase(); if (block.destination?.type === 'section') block.destination.value = block.destination.value.toLowerCase(); }
    } }
  }
  return { document, mediaIds: [...media], mediaRefs, jobTitleIds: document.metadata.audience.job_title_ids };
}

function validateMutation(body, operation) {
  const extra = operation === 'create' ? ['template_id'] : operation === 'draft' ? ['document'] : operation === 'publish' ? ['revision_id'] : [];
  keys(body, ['client_mutation_id', ...(operation === 'create' ? [] : ['expected_version']), ...extra]);
  if (!uuid(body.client_mutation_id)) fail('invalid_mutation');
  if (operation !== 'create' && (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0)) fail('invalid_version');
  if (operation === 'create' && !['comunicado','owner-news','guia-interno'].includes(body.template_id)) fail('invalid_template');
  if (operation === 'publish' && !uuid(body.revision_id)) fail('invalid_revision');
  return body;
}
module.exports = { PagesError, validateDocument, validateMutation, safeLink };
