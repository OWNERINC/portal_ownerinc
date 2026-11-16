import { el, button, field } from './dom.js';
import { newId } from './model.js';

export const mediaAccept = kind => ({ image: 'image/jpeg,image/png,image/webp,image/gif', gif: 'image/gif', audio: 'audio/mpeg,.mp3', video: 'video/mp4,.mp4' }[kind]);
export function mediaKind(file, expected) {
  const kind = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'gif', 'audio/mpeg': 'audio', 'video/mp4': 'video' }[file?.type];
  return kind && (!expected || kind === expected || expected === 'image' && kind === 'gif') && file.size > 0 && file.size <= ({ image: 5, gif: 8, audio: 10, video: 25 }[kind]) * 1024 * 1024 ? kind : null;
}

// No document/editor imports: the coordinator supplies ONE transaction authority,
// native IME guards and keyed rich-editor registration. Every handler resolves
// current IDs, including after history/reorder/source replacement.
export function createBlockFields({ page, block, resolveBlock, transact, upload, onFocus, createRichEditor,
  bindNative: nativeBinder, nativeMeta, canEdit, canAct = canEdit, richOptions, registerEditor, unregisterEditor,
  onSource, onChange = () => {} }) {
  const blockId = block.id, node = el('div', { className: 'pages-block-fields' }), items = new Map(), syncs = [];
  let disposed = false;
  const current = () => !disposed && resolveBlock();
  const retained = () => !!current();
  const bindNative = (control, sync, unavailable, keep = retained) => nativeBinder(control, sync, unavailable, () => keep() && node.contains(control));
  function change(meta, apply) {
    if (!current()) return false;
    const result = transact(meta, doc => apply(doc));
    if (!result) refresh();
    onChange(); return result;
  }
  // The coordinator resolves the supplied block ID in its cloned candidate.
  function mutate(meta, apply) { return change(meta, doc => { const value = doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks))).find(b => b.id === blockId); return value ? apply(value) : false; }); }
  function input(host, key, label, max, resolve, itemId, multiline = false, bucket = syncs) {
    const control = el(multiline ? 'textarea' : 'input', { maxlength: max, 'aria-label': label, 'data-publication-field': key });
    const sync = () => { const value = resolve(); if (value) control.value = value[key]; };
    sync(); bucket.push(sync); bindNative(control, sync, () => !resolve(), () => retained() && !!resolve());
    control.addEventListener('focus', () => onFocus(itemId));
    control.addEventListener('input', event => mutate({ ...nativeMeta(event), group: `${blockId}:${itemId || ''}:${key}`, beforeSelection: null }, value => {
      const target = itemId ? value.items?.find(i => i.id === itemId) : value; if (!target) return false; target[key] = control.value;
    }));
    host.append(field(label, control)); return control;
  }
  function action(host, label, fn, unavailable = () => false, keep = retained) {
    const control = button(label, () => { if (keep() && node.contains(host) && host.contains(control) && canAct() && !unavailable()) fn(); });
    bindNative(control, () => {}, unavailable, keep); host.append(control); return control;
  }
  function picker(host, label, kind, target, multiple = false, keep = retained) {
    const file = el('input', { type: 'file', accept: mediaAccept(kind), multiple, 'aria-label': label, className: 'pages-visually-hidden' });
    const isCurrent = () => keep() && node.contains(host) && host.contains(file);
    bindNative(file, () => { file.value = ''; }, () => !current(), keep);
    action(host, label, () => { file.value = ''; file.click(); }, () => false, keep);
    file.addEventListener('change', () => {
      const files = Array.from(file.files || []); file.value = '';
      if (files.length && isCurrent() && canAct()) upload(files, Object.freeze({ ...target, expectedKind: kind, isCurrent }));
    }); host.append(file);
  }
  const type = block.type;
  if (type === 'gallery' || type === 'faq') {
    if (type === 'gallery') picker(node, 'Adicionar imagens à galeria', 'image', { target: 'gallery', blockId }, true);
    else action(node, 'Adicionar pergunta', () => {
      const id=newId();
      if(!mutate({ closeGroup: true }, value => { if (value.items.length >= 50) return false; value.items.push({ id, question: '', answer: { type: 'doc', content: [{ type: 'paragraph' }] } }); }))return;
      refresh();const entry=items.get(id);if(entry){entry.node.open=true;entry.node.querySelector('input')?.focus();}
    }, () => current()?.items.length >= 50);
  } else {
    const definitions = ['audio','video','video_embed'].includes(type) ? [['title','Título da mídia',200],['transcript','Transcrição (obrigatória para publicar)',20000]] : [['alt','Texto alternativo (obrigatório para publicar)',300],['caption','Legenda',1000],['credit','Crédito',300]];
    for (const [key,label,max] of definitions) input(node, key, label, max, current, null, key === 'transcript');
    if (type === 'video') {
      const cues = el('textarea', { maxlength: 100000, 'aria-label': 'Legendas sincronizadas JSON', 'data-publication-field': 'captions' });
      const sync = () => { cues.value = JSON.stringify(current()?.captions || [], null, 2); }; syncs.push(sync); sync(); bindNative(cues, sync, () => false, retained);
      cues.addEventListener('change', () => { try {
        const captions = JSON.parse(cues.value); let end = 0;
        if (!Array.isArray(captions) || captions.length > 500 || captions.some(c => {
          const bad = !c || Object.keys(c).sort().join(',') !== 'end_ms,start_ms,text' || !Number.isSafeInteger(c.start_ms) || !Number.isSafeInteger(c.end_ms) || c.start_ms < end || c.end_ms <= c.start_ms || c.end_ms > 120000 || typeof c.text !== 'string' || c.text.length > 1000 || /[<>]|-->/.test(c.text); end = c?.end_ms; return bad;
        })) throw Error();
        mutate({ closeGroup: true, beforeSelection: null }, value => { value.captions = captions; });
      } catch { page.toast('Use uma lista JSON de {start_ms,end_ms,text}, ordenada, sem sobreposição (até 500 legendas / 120s).'); } });
      node.append(field('Legendas: [{"start_ms":0,"end_ms":1000,"text":"Exemplo"}]', cues));
    }
    if (type !== 'video_embed') picker(node, 'Substituir arquivo', ['image','gif'].includes(type) ? 'image' : type, { target: 'replace', blockId, sourceType: type });
    if (['video','video_embed'].includes(type)) action(node, 'Trocar fonte do vídeo', () => onSource(blockId));
  }
  function refresh(bookmark) {
    if (disposed || !current()) return;
    syncs.forEach(sync => sync());
    const value = current(); if (!value.items) return;
    const ids = new Set(value.items.map(i => i.id));
    for (const [id, entry] of items) if (!ids.has(id)) disposeItem(id, entry);
    for (const item of value.items) {
      const itemId = item.id;
      let entry = items.get(itemId);
      if (!entry) {
        const host = el(type==='faq'?'details':'div', { 'data-media-item-id': itemId }), localSyncs = [];
        entry = { node: host, syncs: localSyncs, retained: true }; items.set(itemId, entry);
        // IDs survive undo; entry generations do not. Old callbacks must never
        // resolve a newly created entry with the same ID after removal/undo.
        const keep = () => retained() && entry.retained && items.get(itemId) === entry;
        const resolve = () => keep() ? current()?.items?.find(i => i.id === itemId) : null;
        if (type === 'gallery') {
          for (const [key,label,max] of [['alt','Texto alternativo',300],['caption','Legenda',1000],['credit','Crédito',300]]) input(host, key, label, max, resolve, itemId, false, localSyncs);
          picker(host, 'Substituir imagem da galeria', 'image', { target: 'replace', blockId, itemId, sourceType: 'gallery' }, false, keep);
        } else {
          const summary=el('summary',{className:'pages-faq-question',text:item.question||'Pergunta não preenchida'});host.append(summary);
          localSyncs.push(()=>{summary.textContent=resolve()?.question||'Pergunta não preenchida';});
          const question=input(host, 'question', 'Pergunta', 200, resolve, itemId, false, localSyncs);
          question.addEventListener('input',()=>{summary.textContent=resolve()?.question||'Pergunta não preenchida';});
          host.addEventListener('toggle',()=>{if(host.open&&keep())onFocus(itemId);});
          const answer = el('div', { className: 'pages-rich-host', 'data-faq-answer': itemId }); host.append(answer);
          entry.editor = createRichEditor({ ...richOptions, host: answer, content: item.answer, blockId, itemId,
            onFocus: () => { if (keep()) onFocus(itemId); }, onSelection: () => { if (keep()) richOptions.onSelection?.(itemId); },
            onChange(content, meta = {}) { if (!keep()) return; const changed = mutate({ ...meta, group: `${blockId}:${itemId}:answer` }, value => { const target = value.items.find(i => i.id === itemId); if (!target) return false; target.answer = content; }); if (!changed && resolve()) entry.editor.sync(resolve().answer); },
          }); registerEditor(itemId, entry.editor);
        }
        for (const delta of [-1,1]) {
          const text = delta < 0 ? 'Subir item' : 'Descer item';
          action(host, text, () => { mutate({ closeGroup: true }, value => { const from = value.items.findIndex(i => i.id === itemId), to = from + delta; if (from < 0 || to < 0 || to >= value.items.length) return false; const [moved] = value.items.splice(from,1); value.items.splice(to,0,moved); }); refresh(); }, () => { const index = current()?.items.findIndex(i => i.id === itemId); return index < 0 || index + delta < 0 || index + delta >= current()?.items.length; }, keep);
        }
        action(host, 'Remover item', () => { mutate({ closeGroup: true }, value => { const index = value.items.findIndex(i => i.id === itemId); if (index < 0) return false; value.items.splice(index,1); }); refresh(); }, () => false, keep);
      }
      entry.syncs.forEach(sync => sync());
      if (entry.editor) entry.editor.sync(item.answer, bookmark?.blockId === blockId && bookmark.itemId === itemId ? bookmark : null);
      // Reorder existing nodes, not EditorViews. Avoid detaching focused views on
      // ordinary typing/metadata updates.
      if (node.querySelectorAll('[data-media-item-id]')[value.items.indexOf(item)] !== entry.node) {
        const before = node.querySelectorAll('[data-media-item-id]')[value.items.indexOf(item)];
        if (before) node.insertBefore(entry.node, before); else node.append(entry.node);
      }
    }
  }
  function disposeItem(id, entry) {
    entry.retained = false; items.delete(id);
    entry.editor?.destroy(); if (entry.editor) unregisterEditor(id); entry.node.remove();
  }
  refresh();
  return { node, refresh, dispose() { if (disposed) return; disposed = true; items.forEach((entry,id) => disposeItem(id,entry)); node.remove(); } };
}
