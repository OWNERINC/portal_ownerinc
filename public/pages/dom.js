export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.filter(value => value !== undefined && value !== null)); return node;
}
export const button = (text, action, attrs = {}) => el('button', { type: 'button', className: 'btn btn-ghost', text, onClick: action, ...attrs });
export const link = (text, href) => el('a', { text, href });
export function field(text, control) { return el('label', { className: 'pages-field' }, el('span', { text }), control); }
export function errorText(error) {
  if (error.status === 409) return 'Esta página mudou em outra sessão. Recarregue para continuar; suas alterações locais não foram substituídas.';
  if ([403,404].includes(error.status)) return 'Conteúdo indisponível ou acesso não autorizado.';
  const reasons = { invalid_audience: 'Revise os cargos: a publicação aceita apenas cargos ativos.', image_alt_required: 'Preencha o texto alternativo de todas as imagens.',
    page_media_quota: 'Limite de mídia atingido: 50 arquivos ou 100 MiB por página, incluindo o histórico.', unsupported_image: 'Use imagem estática até 5 MiB, GIF até 8 MiB, MP3 até 10 MiB ou MP4 até 25 MiB.', image_too_large: 'A imagem excede 5 MiB.',
    media_too_large: 'O arquivo excede o limite deste tipo de mídia.', media_busy: 'Há outra mídia sendo validada. Aguarde e tente novamente.', media_tool_unavailable: 'A validação de mídia está indisponível no servidor.', invalid_media: 'Mídia inválida ou formato não permitido.', invalid_media_timeline: 'A duração ou os quadros da mídia são inválidos.', media_timeout: 'A validação da mídia excedeu o tempo permitido.', invalid_media_cues: 'As legendas ultrapassam a duração da mídia.', media_accessibility_required: 'Adicione transcrição e, para vídeo, legendas sincronizadas.',
    publication_incomplete: 'Preencha título, texto e cargos antes de publicar.', media_not_ready: 'Uma mídia não está disponível para esta página ou tem tipo diferente.', page_archived: 'Esta página está arquivada.' };
  return reasons[error.reason] || 'Não foi possível concluir. Verifique sua conexão e tente novamente.';
}
export function showError(root, error, retry) {
  root.replaceChildren(el('p', { role: 'alert', text: errorText(error) }), ...(retry ? [button('Tentar novamente', retry)] : []));
}
