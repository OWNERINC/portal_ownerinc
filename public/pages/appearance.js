/* Generated from api/pages/appearance.js by npm run build:pages. Do not edit. */
// Pure, canonical appearance contract. No DOM, media sampling or runtime I/O.
// Keep legacy colors in sync with tokens.css/pages.css, not the new SVG palettes.
const legacy = { font: 'manrope', scale: 'standard', align: 'start',
  foreground: '#2A275E', background: '#FFFEFB', accent: '#E84F1C', icon: 'none' };
const legacyCaptionForeground = '#6C706D'; // figcaption --text-secondary; credit inherits it.
const palettes = {
  neutral: { foreground: legacy.foreground, background: legacy.background },
  brand: { foreground: '#214B39', background: '#E8F1E9' },
  warm: { foreground: '#5A3B19', background: '#F8EEDB' },
};
const fonts = ['manrope', 'source-serif-4', 'oswald'];
const scales = ['small', 'standard', 'large'];
const aligns = ['start', 'center', 'end'];
const icons = ['none', 'info', 'alert', 'check', 'arrow', 'download', 'play', 'upload', 'coffee', 'users', 'headphones', 'shirt'];

function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  return /^#[0-9a-f]{6}$/iu.test(color) && color.length === 7 ? color.toUpperCase() : null;
}
function overlay(base, value) {
  const result = { ...base };
  for (const [key, values] of [['font', fonts], ['scale', scales], ['align', aligns], ['icon', icons]]) {
    if (values.includes(value?.[key])) result[key] = value[key];
  }
  for (const key of ['foreground', 'background', 'accent']) {
    const color = normalizeHex(value?.[key]); if (color) result[key] = color;
  }
  return result;
}
function pageAppearance(doc) { return doc?.schema_version === 3 ? overlay(legacy, doc.presentation?.defaults) : { ...legacy }; }

function resolveAppearance(doc, block, part = 'block') {
  const page = pageAppearance(doc), style = block?.style;
  // Presence of a legacy style pins neutral too. Changing page defaults must not
  // accidentally recolor old unstyled blocks, pinned by upgradeDocument.
  let result = style ? overlay({ ...legacy, ...palettes[style.palette] }, style) : { ...page };
  // These are inner content wrappers, not the styled outer block. Their presets
  // own their colors independently of the outer legacy palette.
  if (block?.type === 'callout') Object.assign(result, palettes[block.tone === 'attention' ? 'warm' : 'brand']);
  if (block?.type === 'button') {
    const colors = style ? legacy : page;
    Object.assign(result, block.preset === 'primary'
      ? { foreground: colors.background, background: colors.foreground }
      : { foreground: colors.foreground, background: block.preset === 'text' ? result.background : colors.background });
  }
  if (doc?.schema_version === 3) {
    result = overlay(result, block?.appearance);
    // 'none' is an explicit page-background choice, not a sampled/unknown color.
    if (block?.appearance?.background === 'none') result.background = page.background;
  }
  // Shared subwrapper contract for validation and the v3 painter: captions and
  // credits are 14px normal text. Legacy styles pin their own muted foreground,
  // not the block's palette foreground. New unstyled v3 captions inherit page
  // text. Explicit v3 foreground wins for either; background always resolves
  // from the containing block (including an explicit 'none' page background).
  if (part === 'caption') {
    result.scale = 'small';
    result.foreground = (doc?.schema_version === 3 && normalizeHex(block?.appearance?.foreground))
      || (doc?.schema_version === 3 && !style ? result.foreground : legacyCaptionForeground);
  }
  if (part === 'link') result.foreground = style ? legacy.foreground : page.foreground;
  return result;
}

function luminance(color) {
  const channels = [1, 3, 5].map(start => {
    const c = parseInt(color.slice(start, start + 2), 16) / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
// Bounded template typography; the same numbers drive CSS, labels and AA checks.
// Legacy documents and explicit scale presets keep their original metrics.
function typographyMetrics(doc, block) {
  const appearance = resolveAppearance(doc, block), scale = appearance.scale;
  const guide = doc?.schema_version === 3 && doc.template?.id === 'guia-interno' && !block?.style && scale === 'standard';
  const cover = guide && doc.sections?.[0]?.rows?.[0]?.columns?.[0]?.blocks?.[0]?.id === block?.id && block?.type === 'rich_text';
  const card = guide && ['coffee','users'].includes(appearance.icon);
  return { body: guide ? (block?.type === 'audio' || block?.type === 'faq' ? 12 : card ? 13 : cover ? 14 : 15) : {small:14,standard:16,large:19.2}[scale],
    h2: guide ? (cover ? 36 : card ? 18 : 20) : scale === 'small' ? 16.1 : scale === 'large' ? 26.88 : 20,
    h3: guide ? (block?.type === 'audio' ? 16 : 18) : scale === 'small' ? 16.1 : scale === 'large' ? 26.88 : 17.6,
    cover, guide };
}
function appearanceIssues(doc) {
  if (doc?.schema_version !== 3) return [];
  const issues = [], page = pageAppearance(doc);
  function check(text, path, appearance, size = 16, bold = false) {
    if (typeof text !== 'string' || !text.trim()) return;
    const a = luminance(appearance.foreground), b = luminance(appearance.background);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    const threshold = size >= 24 || (bold && size >= 18.667) ? 3 : 4.5;
    // Do not round before comparing (e.g. #777777 on white is below 4.5).
    if (ratio < threshold) issues.push({ path, reason: 'color_contrast_required', ratio });
  }
  function prose(node, path, appearance, size, bold = false, linkForeground = page.foreground, metrics) {
    if (!node) return;
    if (node.type === 'heading') {
      // pages.css uses rem for standard headings, em for small/large ones.
      size = metrics ? (node.attrs?.level === 3 ? metrics.h3 : metrics.h2) : appearance.scale === 'small' ? 14 * 1.15 : appearance.scale === 'large' ? 19.2 * 1.4 : node.attrs?.level === 3 ? 17.6 : 20;
      bold = true;
    }
    if (node.type === 'text') {
      const marks = node.marks || [], color = marks.find(mark => mark.type === 'text_color'), highlight = marks.find(mark => mark.type === 'highlight');
      const run = { ...appearance,
        foreground: normalizeHex(color?.attrs?.color) || (marks.some(mark => mark.type === 'link') ? linkForeground : appearance.foreground),
        background: normalizeHex(highlight?.attrs?.color) || appearance.background };
      check(node.text, path, run, size, bold || marks.some(mark => mark.type === 'strong'));
    }
    (node.content || []).forEach((child, i) => prose(child, `${path}.content[${i}]`, appearance, size, bold, linkForeground, metrics));
  }
  const guideMetadata=doc.template?.id==='guia-interno';
  check(doc.metadata?.title, 'metadata.title', page, guideMetadata?14:32, true);
  check(doc.metadata?.summary, 'metadata.summary', page,guideMetadata?12:16);
  (doc.metadata?.tags || []).forEach((tag, i) => check(tag, `metadata.tags[${i}]`, page, 14));
  (doc.sections || []).forEach((section, s) => (section.rows || []).forEach((row, r) => (row.columns || []).forEach((column, c) => (column.blocks || []).forEach((block, b) => {
    const path = `sections[${s}].rows[${r}].columns[${c}].blocks[${b}]`, appearance = resolveAppearance(doc, block);
    const metrics = typographyMetrics(doc,block), size = metrics.body;
    const linkForeground = resolveAppearance(doc, block, 'link').foreground;
    if (['rich_text', 'callout'].includes(block.type)) prose(block.content, `${path}.content`, appearance, size, false, linkForeground,metrics);
    if (block.type === 'button') check(block.label, `${path}.label`, appearance, size);
    if (block.type === 'faq') (block.items || []).forEach((item, i) => {
      check(item.question, `${path}.items[${i}].question`, appearance, size);
      prose(item.answer, `${path}.items[${i}].answer`, appearance, size, false, linkForeground,metrics);
    });
    if(metrics.guide&&block.type==='faq')check(section.label,`${path}.section_label`,appearance,18,true);
    if (['image', 'gif', 'gallery'].includes(block.type)) {
      const captionAppearance = resolveAppearance(doc, block, 'caption');
      const items = block.type === 'gallery' ? block.items || [] : [block];
      items.forEach((item, i) => {
        const itemPath = block.type === 'gallery' ? `${path}.items[${i}]` : path;
        check(item.caption, `${itemPath}.caption`, captionAppearance, 14); check(item.credit, `${itemPath}.credit`, captionAppearance, 14);
      });
    }
    if (['audio', 'video', 'video_embed'].includes(block.type)) {
      const headingSize = metrics.h3;
      check(block.title, `${path}.title`, appearance, headingSize, true); check(block.transcript, `${path}.transcript`, appearance, size);
    }
    (block.tags || []).forEach((tag, i) => check(tag, `${path}.tags[${i}]`, appearance, 14));
  }))));
  return issues;
}

export { normalizeHex, resolveAppearance, appearanceIssues, typographyMetrics };
