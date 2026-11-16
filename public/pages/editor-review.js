import { el, button, field, errorText } from './dom.js';
import { newId, publicationIssues } from './model.js';
import { editV3 } from './document-v3.js';
import { mountPagesDialog } from './dialog.js';

export const reviewURL = workspace => workspace.slug
  ? `/conteudos/${encodeURIComponent(workspace.slug)}` : `/pages.html?id=${encodeURIComponent(workspace.id)}`;

// Sorted-object JSON is a collision-free local fingerprint, not a shortened
// hash. JSONB key order must not invalidate an acknowledged document. Array order
// remains semantic. Neither the fingerprint nor the checklist goes to the API.
function documentHash(value) {
  return JSON.stringify(value, (_key,item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
}
export function createReviewSession(state) {
  const capture = () => ({version:state.workspace.version, revisionId:state.workspace.draft_revision_id,
    documentHash:documentHash(state.document), checks:[false,false,false]});
  let snapshot = capture(), pending = null, uncertain = false, stale = false, blocked = false;
  const same = () => snapshot.version === state.workspace.version && snapshot.revisionId === state.workspace.draft_revision_id && snapshot.documentHash === documentHash(state.document);
  const reset = () => { snapshot.checks.fill(false); };
  const session = {
    get snapshot() { return {...snapshot, checks:[...snapshot.checks]}; },
    get pending() { return pending; }, get uncertain() { return uncertain; }, get stale() { return stale; },
    get ready() { return !stale && !blocked && same() && state.publishable; },
    refresh(unavailable = false) {
      blocked = unavailable;
      if (!same()) { if (!uncertain) { snapshot = capture(); pending = null; } else reset(); }
      if (!state.publishable || blocked || stale) reset();
    },
    check(index, value) { session.refresh(blocked); if (session.ready && index >= 0 && index < 3) snapshot.checks[index] = !!value; },
    verify(workspace) {
      if (uncertain) return true; // Retry the receipt, not a new operation against a new head.
      if (workspace.version !== snapshot.version || workspace.draft_revision_id !== snapshot.revisionId ||
          documentHash(workspace.draft.document) !== snapshot.documentHash || workspace.archived_at || !workspace.capabilities?.publish) {
        stale = true; reset(); return false;
      }
      return true;
    },
    payload() {
      session.refresh(blocked);
      if (!session.ready) throw new Error('Salve e confira novamente a revisão antes de publicar.');
      pending ||= Object.freeze({expected_version:snapshot.version, revision_id:snapshot.revisionId, client_mutation_id:newId()});
      return pending;
    },
    failed(error, submitted = true) { reset(); uncertain = submitted && (!error.status || error.status >= 500); if ([403,404,409].includes(error.status)) stale = true; },
    succeeded() { pending = null; uncertain = false; reset(); },
  };
  // The session belongs to the editor state, not to an open modal. Observe each
  // intermediate mutation/upload even when a later undo/cancel restores its bytes.
  state.subscribe(() => session.refresh(blocked));
  return session;
}

const sessions = new WeakMap();
export function reviewSession(state) {
  if (!sessions.has(state)) sessions.set(state, createReviewSession(state));
  return sessions.get(state);
}

export function openReview({ page, state, api, cargos, onChanged = () => {}, onPublish, canAct = () => true, opener }) {
  const session = reviewSession(state);
  let busy = false, closed = false, checking = false, composing = false, suggestionSequence = 0, modal;
  let lastDocumentHash=JSON.stringify(state.document);
  const live = () => !closed && page.active;
  const canEdit = () => live() && state.editable && !busy && !state.uploads && state.status !== 'conflict' && !session.uncertain && canAct();
  const dialog = el('dialog', {className:'pages-dialog pages-publication-dialog', 'aria-label':'Pronto para compartilhar?', 'data-page-overlay':''});
  const feedback = el('p', {className:'pages-review-feedback',role:'alert'});
  const revision = el('p', {className:'pages-review-revision',role:'status'});
  const validation = el('span', {className:'pages-visually-hidden',id:`pages-review-validation-${newId()}`});
  const title = el('input', {maxlength:200,value:state.document.metadata.title});
  const listId = `pages-review-categories-${newId()}`;
  const category = el('input', {maxlength:80,value:state.document.metadata.category || '',list:listId,autocomplete:'off'});
  const suggestions = el('datalist',{id:listId});
  const categoryAvailable = () => state.document.schema_version === 3 || state.workspace.document_support?.write_versions?.includes(3);
  const close = () => modal.close();
  const x = button('×',close, {className:'pages-review-close','aria-label':'Fechar revisão'});
  const back = button('Voltar à edição',close,{className:'btn btn-ghost pages-review-back'});
  const audience = el('fieldset',{className:'pages-review-cargos'},el('legend',{text:'Cargos ativos selecionados'}));
  const visibility = button('Somente colaboradores', () => {
    audience.hidden = !audience.hidden; visibility.setAttribute('aria-expanded',String(!audience.hidden));
  }, {className:'pages-review-visibility','aria-expanded':'false','aria-controls':`${listId}-cargos`});
  audience.id = `${listId}-cargos`; audience.hidden = true;
  const cargoFields = new Map();
  function change(key, value, event) {
    if (!canEdit() || (key === 'category' && !categoryAvailable())) { refresh(); return; }
    feedback.textContent='';
    const meta = {group:`review:${key}`,beforeSelection:null,composing:composing || !!event?.isComposing};
    let changed;
    if (key === 'category' && state.document.schema_version < 3) {
      const next=editV3(state.document, doc => {doc.metadata.category=value;});
      changed=next ? state.replace(next,meta) : false;
    } else changed=state.transact(meta, doc => {doc.metadata[key]=value;});
    if (changed) onChanged(); refresh();
  }
  for (const [key, control] of [['title',title],['category',category]]) {
    control.addEventListener('input',event=>{change(key,control.value,event);if(key==='category')void loadSuggestions();});
    control.addEventListener('compositionstart',()=>{if(canEdit()){composing=true;state.closeHistoryGroup();refresh();}});
    const end=()=>{queueMicrotask(()=>{if(!live())return;composing=false;state.closeHistoryGroup();refresh();});};
    control.addEventListener('compositionend',end); control.addEventListener('blur',end);
  }
  for (const cargo of cargos) {
    if (!cargo.active && !state.document.metadata.audience.job_title_ids.includes(cargo.id)) continue;
    const control = el('input',{type:'checkbox',value:cargo.id}); cargoFields.set(cargo.id,{control,cargo});
    control.addEventListener('change',()=>{
      const ids=state.document.metadata.audience.job_title_ids;
      if (!canEdit() || (!cargo.active && control.checked) || (control.checked && ids.length >= 100)) {refresh();return;}
      change('audience',{type:'job_titles',job_title_ids:control.checked?[...new Set([...ids,cargo.id])]:ids.filter(id=>id!==cargo.id)});
      state.closeHistoryGroup();
    });
    audience.append(el('label',{},control,document.createTextNode(`${cargo.name}${cargo.active?'':' (inativo — remova antes de publicar)'}`)));
  }
  audience.append(el('p',{text:'Apenas colaboradores com um dos cargos ativos selecionados poderão ler. Nenhum cargo é selecionado automaticamente.'}));
  const url = el('p',{className:'pages-review-url'});
  const checks = el('fieldset',{className:'pages-review-checks'},el('legend',{className:'pages-visually-hidden',text:'Conferência pessoal (não registrada; opcional)'}));
  const checkFields = ['Prévia de celular conferida','Imagens com descrição alternativa','Conteúdo revisado pelo responsável'].map((text,index)=>{
    const input=el('input',{type:'checkbox'});input.addEventListener('change',()=>{session.check(index,input.checked);refresh();});
    checks.append(el('label',{},input,document.createTextNode(text)));return input;
  });
  const save = button('Salvar rascunho',async()=>{
    if (!canEdit() || state.blocked || composing) return;
    busy=true;feedback.textContent='';refresh();
    try {await state.save(api);if(live())feedback.textContent=state.dirty?'Revisão enviada confirmada; ainda há alterações não salvas.':'Rascunho salvo. Confira a nova revisão abaixo.';}
    catch(error){if(live())feedback.textContent=errorText(error);}
    finally {busy=false;if(live()){onChanged();refresh();}}
  });
  const publish = button('Publicar página',async()=>{
    refresh(); if (busy || checking || composing || !session.ready || (!session.uncertain && publicationIssues(state.document,cargos).length)) return;
    busy=true; feedback.textContent=''; refresh();
    let submitted=false;
    try {
      if (!session.uncertain) {
        const remote=await api.workspace(state.workspace.id);
        if (!live()) return;
        session.refresh(!canAct());
        if (!session.verify(remote)) throw Object.assign(new Error(),{status:409});
      }
      if (!live()) return;
      const payload=session.payload();
      submitted=true;
      await onPublish(payload);
      if (!live()) return;
      session.succeeded(); busy=false; onChanged(); modal.close();
    } catch(error) {if(live()){session.failed(error,submitted);feedback.textContent=errorText(error);}}
    finally {busy=false;if(live()){onChanged();refresh();}}
  },{className:'btn btn-primary pages-review-publish'});
  const arrow=el('span',{'aria-hidden':'true',text:'↗'});publish.prepend(arrow);
  const fields=el('div',{className:'pages-review-fields'},field('Título',title),field('Categoria',category),
    el('div',{className:'pages-field'},el('span',{text:'Visibilidade',id:`${listId}-visibility`}),visibility,audience));
  visibility.setAttribute('aria-labelledby',`${listId}-visibility ${listId}-visibility-value`); visibility.id=`${listId}-visibility-value`;
  dialog.append(el('h2',{text:'Pronto para compartilhar?'}),x,el('p',{className:'pages-review-intro',text:'Revise como este conteúdo aparecerá no portal.'}),
    fields,suggestions,url,checks,revision,validation,feedback,el('div',{className:'pages-actions'},save,back,publish));
  publish.setAttribute('aria-describedby',validation.id);
  function refresh() {
    if (!live()) return;
    const documentHash=JSON.stringify(state.document);
    if(documentHash!==lastDocumentHash){feedback.textContent='';lastDocumentHash=documentHash;}
    session.refresh((!canAct() && !busy) || composing);
    const ids=state.document.metadata.audience.job_title_ids;
    title.disabled=!canEdit();category.disabled=!canEdit() || !categoryAvailable();
    if(title.value!==state.document.metadata.title)title.value=state.document.metadata.title;
    if(category.value!==(state.document.metadata.category||''))category.value=state.document.metadata.category||'';
    category.title=categoryAvailable()?'':'Categoria requer escrita v3 habilitada.';
    for(const {control,cargo} of cargoFields.values()){control.checked=ids.includes(cargo.id);control.disabled=!canEdit() || (!cargo.active&&!control.checked);}
    visibility.title=ids.map(id=>cargos.find(c=>c.id===id)?.name||id).join(', ') || 'Nenhum cargo selecionado';
    url.textContent=reviewURL(state.workspace);
    checkFields.forEach((input,index)=>{input.checked=session.snapshot.checks[index];input.disabled=!session.ready||busy||checking;});
    // An uncertain write reconciles its immutable receipt. Current publication
    // validation applies to new writes, not an already committed operation.
    const issues=session.uncertain?[]:publicationIssues(state.document,cargos);
    revision.textContent=session.stale?'Esta revisão mudou em outra sessão. Volte à edição e recarregue.':
      session.uncertain?'Publicação não confirmada. Tente novamente para reconciliar a mesma revisão.':
      !state.publishable?'Alterações ou operações pendentes. Salve e confira a revisão antes de publicar.':
      `Revisão salva: ${session.snapshot.revisionId}${issues.length?` · ${issues.length} pendência(s)`:''}`;
    revision.title=issues.join(' ') || 'Conferência pessoal, opcional e não registrada. Não representa aprovação de outra pessoa.';
    publish.disabled=!session.ready||busy||checking||composing||!!issues.length;
    publish.title=issues.join(' ');
    validation.textContent=issues.join(' ');
    save.hidden=!(state.dirty||state.pending) || !state.workspace.capabilities.edit;
    save.disabled=!canEdit()||state.blocked||composing;
    x.disabled=back.disabled=busy;
  }
  async function loadSuggestions() {
    const sequence=++suggestionSequence;
    try {
      const result=await api.categories({q:category.value,limit:50,offset:0});
      if(live()&&sequence===suggestionSequence)suggestions.replaceChildren(...result.data.map(value=>el('option',{value})));
    } catch {if(live()&&sequence===suggestionSequence)category.title='Sugestões indisponíveis. Você pode digitar uma categoria livre.';}
  }
  async function verifyRemote() {
    if(!live()||busy||checking||session.uncertain||!state.publishable)return;
    const before=JSON.stringify(session.snapshot);
    checking=true;refresh();
    try {const remote=await api.workspace(state.workspace.id);if(live()&&state.publishable&&before===JSON.stringify(session.snapshot))session.verify(remote);}
    catch(error){if(live()){session.snapshot.checks.forEach((_,i)=>session.check(i,false));feedback.textContent=errorText(error);}}
    finally{checking=false;if(live())refresh();}
  }
  const focus=()=>{void verifyRemote();};
  modal=mountPagesDialog({page,dialog,opener,canClose:()=>!busy,onClose:()=>{closed=true;window.removeEventListener('focus',focus);state.closeHistoryGroup();}});
  window.addEventListener('focus',focus);refresh();back.focus();void loadSuggestions();void verifyRemote();
  return {close:modal.close,refresh};
}
