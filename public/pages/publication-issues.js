import { appearanceIssues } from './appearance.js';

// One publication-only validator for structurally valid drafts. Keep legacy
// aggregate messages/order: each aggregate navigates to its first failing block.
// Schema, private media ownership/kind and current authorization remain server-owned.
export function publicationIssueDetails(doc, cargos) {
  const issues = [];
  const add = (code, message, target = {}) => issues.push({ code, message, ...target });
  if (!doc.metadata.title.trim()) add('title_required', 'Preencha o título.', { field: 'title' });
  const selected = doc.metadata.audience.job_title_ids;
  if (!selected.length || selected.some(id => !cargos.some(cargo => cargo.id === id && cargo.active === true))) add('audience_required', 'Selecione apenas cargos atualmente ativos.', { field: 'audience' });
  const blocks = doc.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks)));
  function meaningful(node) { return node.type === 'text' && !!node.text?.trim() || (node.content || []).some(meaningful); }
  const v3 = doc.schema_version === 3;
  if (!blocks.some(block => ['rich_text','callout'].includes(block.type) && meaningful(block.content)
    || v3 && block.type === 'faq' && block.items.some(item => meaningful(item.answer)))) {
    const block = blocks.find(value => ['rich_text','callout'].includes(value.type));
    add('text_required', v3 ? 'Adicione conteúdo de texto à página ou a uma resposta de FAQ.' : 'Adicione conteúdo de texto ao comunicado.', block ? { blockId: block.id, field: 'content' } : {});
  }
  const image = blocks.find(block => ['image','gif'].includes(block.type) && (!block.media_id || !block.alt.trim()));
  if (image) add('image_required', 'Todas as imagens precisam estar prontas e ter texto alternativo.', { blockId: image.id, field: !image.media_id ? 'media_id' : 'alt' });
  const media = blocks.find(block => ['audio','video'].includes(block.type) && (!block.media_id || !block.transcript.trim() || (block.type === 'video' && !block.captions.length)));
  if (media) add('media_accessibility_required', 'Áudio e vídeo precisam de transcrição; vídeo também precisa de legendas sincronizadas.', { blockId: media.id, field: !media.media_id ? 'media_id' : !media.transcript.trim() ? 'transcript' : 'captions' });
  if (v3) blocks.forEach((block, index) => {
    const location = `bloco ${index + 1}`, target = { blockId: block.id };
    if (block.type === 'gallery') {
      if (!block.items.length) add('gallery_empty', `Galeria (${location}): adicione pelo menos uma imagem ou GIF.`, { ...target, field: 'items' });
      block.items.forEach((item, itemIndex) => {
        const itemTarget = { ...target, itemId: item.id };
        if (!item.media_id) add('gallery_media_required', `Galeria (${location}), item ${itemIndex + 1}: selecione um arquivo de imagem ou GIF.`, { ...itemTarget, field: 'media_id' });
        if (!item.alt.trim()) add('gallery_alt_required', `Galeria (${location}), item ${itemIndex + 1}: preencha o texto alternativo.`, { ...itemTarget, field: 'alt' });
      });
    } else if (block.type === 'faq') {
      if (!block.items.length) add('faq_empty', `FAQ (${location}): adicione pelo menos uma pergunta com resposta.`, { ...target, field: 'items' });
      block.items.forEach((item, itemIndex) => {
        const itemTarget = { ...target, itemId: item.id };
        if (!item.question.trim()) add('faq_question_required', `FAQ (${location}), item ${itemIndex + 1}: preencha a pergunta.`, { ...itemTarget, field: 'question' });
        if (!meaningful(item.answer)) add('faq_answer_required', `FAQ (${location}), item ${itemIndex + 1}: escreva o texto da resposta.`, { ...itemTarget, field: 'answer' });
      });
    } else if (block.type === 'video_embed') {
      if (!block.title.trim()) add('embed_title_required', `Vídeo incorporado (${location}): preencha o título.`, { ...target, field: 'title' });
      if (!block.transcript.trim()) add('embed_transcript_required', `Vídeo incorporado (${location}): preencha a transcrição.`, { ...target, field: 'transcript' });
    }
  });
  // Appearance paths can describe inline marks or inherited values. Do not invent
  // an editable field from that path; retain the complete explanatory message.
  for (const issue of appearanceIssues(doc)) add('color_contrast_required', `Contraste AA insuficiente em ${issue.path} (${issue.ratio.toFixed(2)}:1).`);
  return issues;
}

// Resolve stable IDs against the current document, never a cached review object.
export function publicationIssueTarget(doc, issue) {
  if (!issue.blockId) return ['title', 'audience'].includes(issue.field) ? { field: issue.field } : null;
  const block = doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks))).find(b => b.id === issue.blockId);
  if (!block || (issue.itemId && !block.items?.some(item => item.id === issue.itemId))) return null;
  if (issue.field === 'items' ? !['faq', 'gallery'].includes(block.type)
    : !Object.hasOwn(issue.itemId ? block.items.find(item => item.id === issue.itemId) : block, issue.field)) return null;
  return { blockId: block.id, ...(issue.itemId ? { itemId: issue.itemId } : {}), field: issue.field };
}
