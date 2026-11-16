import { el, button, field } from './dom.js';
import { allBlocks, clone, safeLink } from './model.js';
import { findBlock, insertAt } from './composition.js';
import { upgradeDocument } from './document-v3.js';

const extensions = { image: '.webp', gif: '.gif', audio: '.mp3', video: '.mp4' };
const uuid = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const registeredMedia = media => (media || []).filter(m => uuid(m.id) && Object.hasOwn(extensions, m.kind));

// Resolve against the current server inventory/document at commit time. A UI
// choice is not a reference proof; the server rechecks page ownership on save.
export function destinationCandidate(document, blockId, action, media, v3Enabled) {
  const advanced = ['download','video'].includes(action?.type);
  if (!action || advanced && !v3Enabled || document.schema_version === 3 && !v3Enabled) return null;
  if (action.type === 'download') {
    const extension = extensions[action.kind];
    if (!registeredMedia(media).some(m => m.id === action.media_id && m.kind === action.kind) ||
        typeof action.file_name !== 'string' || action.file_name.length > 120 || /[\/\\\u0000-\u001f\u007f-\u009f]/u.test(action.file_name) ||
        !extension || !action.file_name.endsWith(extension) || !action.file_name.slice(0,-extension.length).trim()) return null;
  }
  if (action.type === 'video' && !allBlocks(document).some(b => b.id === action.value && ['video','video_embed'].includes(b.type))) return null;
  const next = advanced ? upgradeDocument(document) : clone(document), found = findBlock(next, blockId);
  if (found?.block.type !== 'button') return null;
  const key = next.schema_version === 3 ? 'action' : 'destination';
  if (JSON.stringify(found.block[key]) === JSON.stringify(action)) return null;
  found.block[key] = clone(action);
  const block = found.column.blocks.splice(found.index,1)[0];
  return insertAt(next, { columnId: found.column.id, index: found.index, block });
}

export function createDestinationFields({ blockId, getDocument, getMedia, v3Enabled, bindNative, retained, canAct, apply }) {
  let disposed = false;
  const live = () => !disposed && retained();
  const current = () => { const b = findBlock(getDocument(),blockId)?.block; return b?.action || b?.destination; };
  const target = el('select', { 'aria-label': 'Tipo de destino' });
  const address = el('input', { maxlength: 2048, 'aria-label': 'Endereço' });
  const media = el('select', { 'aria-label': 'Arquivo da página' });
  const kind = el('output', { 'aria-label': 'Tipo do arquivo' });
  const filename = el('input', { maxlength: 120, 'aria-label': 'Nome do arquivo para download' });
  const video = el('select', { 'aria-label': 'Vídeo da página' });
  const message = el('p', { role: 'status', className: 'pages-help' });
  const addressField = field('Endereço',address);
  const downloadFields = el('div', {className:'pages-destination-download'}, field('Arquivo da página',media), field('Tipo do arquivo',kind), field('Nome do arquivo para download',filename));
  const videoField = field('Vídeo da página',video);
  const advanced = () => ['download','video'].includes(target.value);
  const gate = () => advanced() && !v3Enabled();
  const controls = [target,address,media,filename,video];
  function visibility() {
    addressField.hidden = target.value !== 'url'; downloadFields.hidden = target.value !== 'download'; videoField.hidden = target.value !== 'video';
    submit.hidden = !advanced(); submit.disabled = !canAct() || gate();
    kind.textContent = registeredMedia(getMedia()).find(m => m.id === media.value)?.kind || 'Indisponível';
  }
  function refresh() {
    const action = current(); if (!action || !live()) return;
    target.replaceChildren(el('option', { value:'url', text:'Endereço HTTPS ou /caminho' }),
      ...getDocument().sections.map(s => el('option', {value:s.id,text:`Seção: ${s.label}`})),
      ...[['download','Download de arquivo'],['video','Vídeo da página']].map(([value,text]) => el('option',{value,text,disabled:!v3Enabled()})));
    target.value = ['url','download','video'].includes(action.type) ? action.type : action.value;
    address.value = action.type === 'url' ? action.value : '';
    const files = registeredMedia(getMedia());
    media.replaceChildren(el('option',{value:'',text:files.length?'Selecione um arquivo':'Nenhum arquivo compatível registrado'}), ...files.map(m=>el('option',{value:m.id,text:`${m.kind} · ${m.id}`})));
    media.value = action.type === 'download' ? action.media_id : '';
    filename.value = action.type === 'download' ? action.file_name : '';
    const videos = allBlocks(getDocument()).filter(b=>['video','video_embed'].includes(b.type));
    video.replaceChildren(el('option',{value:'',text:videos.length?'Selecione um vídeo':'Nenhum bloco de vídeo nesta página'}), ...videos.map(b=>el('option',{value:b.id,text:b.title || `Vídeo · ${b.id}`})));
    video.value = action.type === 'video' ? action.value : '';
    message.textContent = !v3Enabled() ? 'Download e vídeo exigem escrita v3 habilitada.' :
      action.type === 'download' && !files.some(m=>m.id===action.media_id&&m.kind===action.kind) ? 'Arquivo ausente ou incompatível. Escolha um arquivo registrado nesta página.' :
      action.type === 'video' && !videos.some(b=>b.id===action.value) ? 'Vídeo de destino removido. Escolha outro bloco de vídeo.' : '';
    visibility();
  }
  function commit() {
    if (!live() || !canAct() || gate()) { refresh(); return; }
    const file = registeredMedia(getMedia()).find(m=>m.id===media.value);
    const action = target.value === 'download' ? { type:'download',media_id:media.value,kind:file?.kind,file_name:filename.value } :
      target.value === 'video' ? {type:'video',value:video.value} : target.value === 'url' ? {type:'url',value:address.value} : {type:'section',value:target.value};
    const candidate = destinationCandidate(getDocument(),blockId,action,getMedia(),v3Enabled());
    if (candidate && apply(candidate)) { message.textContent = 'Destino aplicado ao rascunho. Salve para persistir.'; return; }
    if (JSON.stringify(action) === JSON.stringify(current())) refresh();
    else message.textContent = 'Destino inválido. Escolha um alvo disponível e um nome com extensão compatível (.webp, .gif, .mp3 ou .mp4).';
  }
  const submit = button('Aplicar destino',commit);
  bindNative(submit,visibility,()=>!canAct()||gate(),live);
  for (const control of controls) bindNative(control,refresh,()=>control!==target&&gate(),live);
  target.addEventListener('change',()=>{
    if (gate()) { refresh(); return; }
    message.textContent = advanced() ? 'Selecione o destino e aplique. O rascunho ainda não foi alterado.' : '';
    visibility();
    if (!advanced() && (target.value!=='url' || safeLink(address.value))) commit();
  });
  media.addEventListener('change',()=>{ visibility(); });
  address.addEventListener('change',commit);
  const node = el('div', {className:'pages-button-destination'},field('Destino',target),addressField,downloadFields,videoField,submit,message);
  return { node, refresh, dispose(){ disposed=true; } };
}
