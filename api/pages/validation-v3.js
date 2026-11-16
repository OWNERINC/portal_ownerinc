// Private v3 contract. validateDocument remains the public entry point and owns
// the JSON byte limit. Error/link dependencies are injected to avoid a cycle.
const { uuid } = require('../route-utils');
const { createRichTextValidator } = require('./validation-common');
const { appearanceIssues } = require('./appearance');

const fonts = ['manrope', 'source-serif-4', 'oswald'];
const scales = ['small', 'standard', 'large'];
const aligns = ['start', 'center', 'end'];
const icons = ['none', 'info', 'alert', 'check', 'arrow', 'download', 'play', 'upload', 'coffee', 'users', 'headphones', 'shirt'];
const mediaKinds = ['image', 'gif', 'audio', 'video'];
const extensions = { image: '.webp', gif: '.gif', audio: '.mp3', video: '.mp4' };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// The legacy UUID helper uses $, which also matches before a final newline.
// Keep its legacy semantics untouched while requiring exact UUIDs in v3.
const exactUuid = value => typeof value === 'string' && value.length === 36 && uuid(value);

function validateV3(input, { publishing = false, PagesError, safeLink }) {
  const fail = (reason = 'invalid_document') => { throw new PagesError(400, reason); };
  function keys(value, required, optional = []) {
    if (!object(value) || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => ![...required, ...optional].includes(key) || value[key] === undefined)) fail();
  }
  let chars = 0, nodes = 0, rows = 0, blocks = 0, meaningfulTexts = 0;
  const ids = new Set(), media = new Set(), mediaRefs = [], destinations = [], videoIds = new Set();
  function text(value, max) {
    if (typeof value !== 'string' || value.length > max || /\u0000/u.test(value)) fail();
  }
  function countText(value, max) { text(value, max); chars += value.length; if (chars > 100000) fail(); }
  function countNode() { if (++nodes > 20000) fail(); }
  function id(value) { if (!exactUuid(value) || ids.has(value.toLowerCase())) fail(); ids.add(value.toLowerCase()); }
  function tags(value) {
    if (!Array.isArray(value) || value.length > 20 || new Set(value).size !== value.length) fail();
    value.forEach(tag => { countText(tag, 40); if (!tag.trim()) fail(); });
  }
  function hex(value) { if (typeof value !== 'string' || value.length !== 7 || !/^#[0-9a-f]{6}$/iu.test(value)) fail(); }
  function typography(value) {
    for (const [key, values] of [['font', fonts], ['scale', scales], ['align', aligns]]) {
      if (Object.hasOwn(value, key) && !values.includes(value[key])) fail();
    }
  }
  function appearance(value) {
    keys(value, [], ['font', 'scale', 'align', 'foreground', 'background', 'accent', 'icon']);
    typography(value);
    for (const key of ['foreground', 'background', 'accent']) {
      if (Object.hasOwn(value, key) && !(key === 'background' && value[key] === 'none')) hex(value[key]);
    }
    if (Object.hasOwn(value, 'icon') && !icons.includes(value.icon)) fail();
  }
  function style(value) {
    keys(value, ['align', 'scale', 'palette', 'font']); typography(value);
    if (!['neutral', 'brand', 'warm'].includes(value.palette)) fail();
  }
  function reference(value, kind, placeholder = true) {
    if (value === null && placeholder) { if (publishing) fail('media_not_ready'); return; }
    if (!exactUuid(value) || !mediaKinds.includes(kind)) fail();
    const normalized = value.toLowerCase(); media.add(normalized); mediaRefs.push({ id: normalized, kind });
  }
  function marks(value) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 6) fail();
    const seen = new Set();
    for (const mark of value) {
      countNode(); keys(mark, ['type'], ['attrs']);
      if (seen.has(mark.type)) fail(); seen.add(mark.type);
      if (mark.type === 'link') {
        keys(mark.attrs, ['href']); if (!safeLink(mark.attrs.href)) fail(); countText(mark.attrs.href, 2048);
      } else if (['text_color', 'highlight'].includes(mark.type)) {
        keys(mark.attrs, ['color']); hex(mark.attrs.color); countText(mark.attrs.color, 7);
      } else if (!['strong', 'em', 'underline'].includes(mark.type) || Object.hasOwn(mark, 'attrs')) fail();
    }
  }
  const pm = createRichTextValidator({ fail, object, keys, text, marks, countNode,
    onText(value) { countText(value, 100000); if (value.trim()) meaningfulTexts++; },
  });
  function prose(value) { if (value?.type !== 'doc') fail(); pm(value); }
  function image(value, kind) {
    reference(value.media_id, kind); countText(value.alt, 300); countText(value.caption, 1000); countText(value.credit, 300);
    if (publishing && !value.alt.trim()) fail('image_alt_required');
  }
  function captions(value) {
    if (!Array.isArray(value) || value.length > 500) fail();
    let end = 0;
    for (const cue of value) {
      keys(cue, ['start_ms', 'end_ms', 'text']); countText(cue.text, 1000);
      if (!Number.isSafeInteger(cue.start_ms) || !Number.isSafeInteger(cue.end_ms) || cue.start_ms < end
        || cue.end_ms <= cue.start_ms || cue.end_ms > 120000 || /[<>]|-->/u.test(cue.text)) fail();
      end = cue.end_ms;
    }
  }
  function action(value) {
    if (!object(value)) fail();
    if (value.type === 'download') {
      keys(value, ['type', 'media_id', 'kind', 'file_name']);
      if (!mediaKinds.includes(value.kind)) fail();
      countText(value.file_name, 120);
      if (/[\/\\\u0000-\u001f\u007f-\u009f]/u.test(value.file_name)
        || !value.file_name.endsWith(extensions[value.kind]) || !value.file_name.slice(0, -extensions[value.kind].length).trim()) fail();
      reference(value.media_id, value.kind, false);
    } else {
      keys(value, ['type', 'value']);
      if (value.type === 'section' || value.type === 'video') {
        if (!exactUuid(value.value)) fail(); destinations.push({ type: value.type, id: value.value.toLowerCase() });
      } else if (value.type === 'url' && safeLink(value.value)) countText(value.value, 2048);
      else fail();
    }
  }
  function block(value) {
    if (++blocks > 100 || !object(value)) fail();
    id(value.id);
    const optional = ['style', 'appearance', 'tags'];
    if (Object.hasOwn(value, 'style')) style(value.style);
    if (Object.hasOwn(value, 'appearance')) appearance(value.appearance);
    if (Object.hasOwn(value, 'tags')) tags(value.tags);
    const shape = required => keys(value, ['id', 'type', ...required], optional);
    switch (value.type) {
      case 'rich_text': case 'callout':
        shape(['content', ...(value.type === 'callout' ? ['tone', 'icon'] : [])]);
        if (value.type === 'callout' && (!['info', 'attention', 'success'].includes(value.tone) || !['none', 'info', 'alert', 'check'].includes(value.icon))) fail();
        prose(value.content); break;
      case 'image': case 'gif':
        shape(['media_id', 'alt', 'caption', 'credit']); image(value, value.type); break;
      case 'audio': case 'video':
        shape(['media_id', 'title', 'transcript', ...(value.type === 'video' ? ['captions'] : [])]);
        reference(value.media_id, value.type); countText(value.title, 200); countText(value.transcript, 20000);
        if (value.type === 'video') { captions(value.captions); videoIds.add(value.id.toLowerCase()); }
        if (publishing && (!value.transcript.trim() || (value.type === 'video' && !value.captions.length))) fail('media_accessibility_required');
        break;
      case 'gallery':
        shape(['items']);
        if (!Array.isArray(value.items) || value.items.length > 50) fail();
        if (publishing && !value.items.length) fail('publication_incomplete');
        for (const item of value.items) {
          keys(item, ['id', 'kind', 'media_id', 'alt', 'caption', 'credit']); id(item.id);
          if (!['image', 'gif'].includes(item.kind)) fail(); image(item, item.kind);
        }
        break;
      case 'faq':
        shape(['items']);
        if (!Array.isArray(value.items) || value.items.length > 50) fail();
        if (publishing && !value.items.length) fail('publication_incomplete');
        for (const item of value.items) {
          keys(item, ['id', 'question', 'answer']); id(item.id); countText(item.question, 200);
          const before = meaningfulTexts; prose(item.answer);
          if (publishing && (!item.question.trim() || meaningfulTexts === before)) fail('publication_incomplete');
        }
        break;
      case 'video_embed':
        shape(['provider', 'video_id', 'title', 'transcript']);
        if (value.provider !== 'youtube' || typeof value.video_id !== 'string' || value.video_id.length !== 11 || !/^[A-Za-z0-9_-]{11}$/u.test(value.video_id)) fail();
        countText(value.title, 200); countText(value.transcript, 20000); videoIds.add(value.id.toLowerCase());
        if (publishing && (!value.title.trim() || !value.transcript.trim())) fail('media_accessibility_required');
        break;
      case 'button':
        shape(['label', 'preset', 'action']); countText(value.label, 120);
        if (!value.label.trim() || !['primary', 'secondary', 'text'].includes(value.preset)) fail();
        action(value.action); break;
      case 'divider': shape([]); break;
      default: fail();
    }
  }

  keys(input, ['schema_version', 'template', 'metadata', 'presentation', 'sections']);
  if (input.schema_version !== 3) fail();
  keys(input.template, ['id', 'version']);
  if (!(input.template.id === 'comunicado' && input.template.version === 3)
    && !(input.template.id === 'owner-news' && input.template.version === 2)
    && !(input.template.id === 'guia-interno' && input.template.version === 1)) fail();
  const meta = input.metadata;
  keys(meta, ['title', 'summary', 'tags', 'audience', 'category']);
  countText(meta.title, 200); countText(meta.summary, 1000); countText(meta.category, 80); tags(meta.tags);
  keys(meta.audience, ['type', 'job_title_ids']);
  const cargos = meta.audience.job_title_ids;
  if (meta.audience.type !== 'job_titles' || !Array.isArray(cargos) || cargos.length > 100 || !cargos.every(exactUuid)
    || new Set(cargos.map(value => value.toLowerCase())).size !== cargos.length) fail();
  keys(input.presentation, ['theme', 'defaults']);
  if (input.presentation.theme !== 'conecta') fail();
  const defaults = input.presentation.defaults;
  keys(defaults, ['font', 'scale', 'align', 'palette', 'foreground', 'background', 'accent']); typography(defaults);
  if (!['conecta', 'editorial', 'neutro'].includes(defaults.palette)) fail();
  for (const key of ['foreground', 'background', 'accent']) hex(defaults[key]);
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 20) fail();
  const sectionIds = new Set();
  for (const section of input.sections) {
    keys(section, ['id', 'label', 'rows']); id(section.id); sectionIds.add(section.id.toLowerCase()); countText(section.label, 200);
    if (!Array.isArray(section.rows) || !section.rows.length) fail();
    for (const row of section.rows) {
      if (++rows > 100) fail(); keys(row, ['id', 'layout', 'columns']); id(row.id);
      if (!['single', 'two_equal', 'aside_right'].includes(row.layout) || !Array.isArray(row.columns)
        || row.columns.length !== (row.layout === 'single' ? 1 : 2)) fail();
      for (const column of row.columns) {
        keys(column, ['id', 'blocks']); id(column.id);
        if (!Array.isArray(column.blocks)) fail(); column.blocks.forEach(block);
      }
    }
  }
  for (const target of destinations) {
    if (!(target.type === 'section' ? sectionIds : videoIds).has(target.id)) fail(target.type === 'section' ? 'invalid_section_target' : 'invalid_video_target');
  }
  if (publishing && (!meta.title.trim() || !meaningfulTexts || !cargos.length)) fail('publication_incomplete');
  // Only schema-defined identity/color keys are canonicalized; prose, tags,
  // captions, filenames and hrefs are preserved even when they resemble UUIDs.
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, field]) => {
      if (['id', 'media_id'].includes(key) && uuid(field)) field = field.toLowerCase();
      else if (key === 'job_title_ids') field = field.map(item => item.toLowerCase());
      else if (key === 'value' && ['section', 'video'].includes(value.type)) field = field.toLowerCase();
      else if (['foreground', 'background', 'accent', 'color'].includes(key) && field !== 'none') field = field.toUpperCase();
      return [key, canonical(field)];
    }));
  }
  const document = canonical(input);
  if (publishing && appearanceIssues(document).length) fail('color_contrast_required');
  return { document, mediaIds: [...media], mediaRefs, jobTitleIds: document.metadata.audience.job_title_ids };
}

module.exports = { validateV3 };
