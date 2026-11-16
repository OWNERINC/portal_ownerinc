import { appearanceIssues } from './appearance.js';

export const clone = value => JSON.parse(JSON.stringify(value));
export const newId = () => crypto.randomUUID();
export const canPages = (user, permission) => user?.role === 'admin' && (user.permissions?.superAdmin === true || user.permissions?.[permission] === true);
export const allBlocks = doc => doc.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks)));
export function blockList(doc) { return doc.sections[0].rows[0].columns[0].blocks; }
export function textBlock() { return { id: newId(), type: 'rich_text', content: { type: 'doc', content: [{ type: 'paragraph' }] } }; }
export function safeLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) {
    try { return new URL(value, 'https://pages.invalid').origin === 'https://pages.invalid'; } catch { return false; }
  }
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export function publicationIssues(doc, cargos) {
  const issues = [];
  if (!doc.metadata.title.trim()) issues.push('Preencha o título.');
  const selected = doc.metadata.audience.job_title_ids;
  if (!selected.length || selected.some(id => !cargos.some(cargo => cargo.id === id && cargo.active === true))) issues.push('Selecione apenas cargos atualmente ativos.');
  const blocks = allBlocks(doc);
  function meaningful(node) { return node.type === 'text' && !!node.text?.trim() || (node.content || []).some(meaningful); }
  const v3 = doc.schema_version === 3;
  if (!blocks.some(block => ['rich_text','callout'].includes(block.type) && meaningful(block.content)
    || v3 && block.type === 'faq' && block.items.some(item => meaningful(item.answer)))) {
    issues.push(v3 ? 'Adicione conteúdo de texto à página ou a uma resposta de FAQ.' : 'Adicione conteúdo de texto ao comunicado.');
  }
  if (blocks.some(block => ['image','gif'].includes(block.type) && (!block.media_id || !block.alt.trim()))) issues.push('Todas as imagens precisam estar prontas e ter texto alternativo.');
  if (blocks.some(block => ['audio','video'].includes(block.type) && (!block.media_id || !block.transcript.trim() || (block.type === 'video' && !block.captions.length)))) issues.push('Áudio e vídeo precisam de transcrição; vídeo também precisa de legendas sincronizadas.');
  // Publication-only checks for structurally valid drafts. The server still owns
  // schema, private media ownership/kind and current audience authorization.
  if (v3) blocks.forEach((block, index) => {
    const location = `bloco ${index + 1}`;
    if (block.type === 'gallery') {
      if (!block.items.length) issues.push(`Galeria (${location}): adicione pelo menos uma imagem ou GIF.`);
      block.items.forEach((item, itemIndex) => {
        if (!item.media_id) issues.push(`Galeria (${location}), item ${itemIndex + 1}: selecione um arquivo de imagem ou GIF.`);
        if (!item.alt.trim()) issues.push(`Galeria (${location}), item ${itemIndex + 1}: preencha o texto alternativo.`);
      });
    } else if (block.type === 'faq') {
      if (!block.items.length) issues.push(`FAQ (${location}): adicione pelo menos uma pergunta com resposta.`);
      block.items.forEach((item, itemIndex) => {
        if (!item.question.trim()) issues.push(`FAQ (${location}), item ${itemIndex + 1}: preencha a pergunta.`);
        if (!meaningful(item.answer)) issues.push(`FAQ (${location}), item ${itemIndex + 1}: escreva o texto da resposta.`);
      });
    } else if (block.type === 'video_embed') {
      if (!block.title.trim()) issues.push(`Vídeo incorporado (${location}): preencha o título.`);
      if (!block.transcript.trim()) issues.push(`Vídeo incorporado (${location}): preencha a transcrição.`);
    }
  });
  for (const issue of appearanceIssues(doc)) issues.push(`Contraste AA insuficiente em ${issue.path} (${issue.ratio.toFixed(2)}:1).`);
  return issues;
}
