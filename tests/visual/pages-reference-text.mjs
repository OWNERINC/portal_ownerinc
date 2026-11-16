// Source-owned text contract, independent of captures. Original PNGs remain immutable.
// Classifications below are read from each original PNG, never from captures.
const clear=reason=>({exposure:'visible',backdropAlpha:0,reason});
const scrim=reason=>({exposure:'visible',backdropAlpha:0.4,reason});
const covered=(occluderRegion,reason)=>({exposure:'underlyingDOM',occluderRegion,reason});
export const sourceTextVisibility={
  'desktop-style':{
    header:clear('reference-3: header above the panel, transparent backdrop'),
    canvas:covered('style-popover','reference-3: heading crosses the opaque panel x360–760, y118–781'),
    'selected-block':covered('style-popover','reference-3: introduction heading crosses the opaque panel'),
    inspector:clear('reference-3: inspector is to the right of the panel'),
    'daily-card':covered('style-popover','reference-3: No dia a dia is partly covered at the left panel edge'),
    'meetings-card':clear('reference-3: Em encontros starts to the right of the panel'),
    faq:clear('reference-3: FAQ heading is below the panel'),
    'audio-placeholder':clear('reference-3: audio heading is right of and below the panel'),
  },
  'desktop-insert':{
    header:clear('reference-4: header above the panel, transparent backdrop'),
    canvas:covered('insert-popover','reference-4: heading starts behind the opaque panel x24–404, y118–739'),
    'selected-block':covered('insert-popover','reference-4: introduction heading starts behind the opaque panel'),
    inspector:clear('reference-4: inspector is to the right of the panel'),
    'daily-card':covered('insert-popover','reference-4: No dia a dia is behind the opaque panel'),
    'meetings-card':clear('reference-4: Em encontros is to the right of the panel'),
    faq:clear('reference-4: FAQ heading is below the panel'),
    'audio-placeholder':clear('reference-4: audio heading is right of and below the panel'),
  },
  'desktop-review':{
    header:scrim('reference-5: header remains readable through the 40% scrim above the panel'),
    canvas:covered('review-dialog','reference-5: heading crosses the opaque panel x510–1090, y190–860'),
    'selected-block':covered('review-dialog','reference-5: introduction heading crosses the opaque panel'),
    inspector:scrim('reference-5: inspector remains readable through the scrim right of the panel'),
    'daily-card':scrim('reference-5: No dia a dia remains readable through the scrim left of the panel'),
    'meetings-card':covered('review-dialog','reference-5: Em encontros is behind the opaque panel'),
    faq:scrim('reference-5: FAQ heading remains readable through the scrim left of the panel'),
    'audio-placeholder':covered('review-dialog','reference-5: Prefere ouvir begins behind the right edge of the opaque panel'),
  },
};
const item = (region, text, extra = {}) => ({ region, text, exposure: 'visible', kind: 'text', ...extra });
export function expectedText(id) {
  if (id === 'editable-buttons') return ['Ver guia completo','Baixar material','Assistir ao vídeo','Enviar arquivo','Salvo'].map((t,i)=>item(['primary','secondary','video','upload','confirmed'][i],t));
  if (!['desktop-contextual','desktop-style','desktop-insert','desktop-review','mobile-content'].includes(id)) throw Error(`Unknown source text contract: ${id}`);
  const mobile=id==='mobile-content';
  const base=[item('header','Código de vestimenta'),item(mobile?'preview':'canvas','Vestir-se bem é'),item('selected-block','Para cada momento, uma escolha')];
  if(!mobile)base.push(...[['inspector','Introdução'],['daily-card','No dia a dia'],['meetings-card','Em encontros'],['faq','Dúvidas frequentes'],['audio-placeholder','Prefere ouvir?']].map(([r,t])=>item(r,t)));
  if(sourceTextVisibility[id])for(const entry of base){
    const classification=sourceTextVisibility[id][entry.region];
    if(!classification)throw Error(`Missing per-source text visibility: ${id}/${entry.region}`);
    Object.assign(entry,classification);
  }
  if(id==='desktop-style')base.push(...['Estilo da página','Clareza em cada detalhe.','Editorial','Neutro','Aplicar estilo'].map(t=>item('style-popover',t)));
  if(id==='desktop-insert')base.push(...['O que você quer adicionar?','Texto','Imagem ou GIF','Vídeo','Áudio','Galeria','Duas colunas','Destaque ou botão'].map(t=>item('insert-popover',t)));
  if(id==='desktop-review')base.push(item('review-dialog','Pronto para compartilhar?'),item('category-field','Pessoas e cultura',{kind:'input-value'}),item('visibility-field','Somente colaboradores'),item('review-dialog','Prévia de celular conferida'),item('publish-page','Publicar página'));
  if(mobile)base.push(...['Editar bloco','Conteúdo','Posição'].map(t=>item('bottom-sheet',t)),item('typography','Manrope · 16 px',{kind:'selected-value'}),item('background','Padrão Conecta',{kind:'selected-value'}),item('finish-editing','Concluir edição'));
  return base;
}
export function assertTextCoverage(id, checks) {
  const expected=expectedText(id),key=t=>JSON.stringify([t.region,t.text]);
  if(!Array.isArray(checks)||checks.length!==expected.length||new Set(checks.map(key)).size!==expected.length||expected.some(t=>!checks.some(c=>key(c)===key(t))))throw Error(`${id}: incomplete/duplicate/wrong-region text coverage`);
  return expected;
}
export function compareText(id, capture, regions) {
  const expected=assertTextCoverage(id,capture.textChecks);
  if(!Array.isArray(capture.text)||!Array.isArray(capture.underlyingDOM))throw Error(`${id}: corrected visible/underlyingDOM inventory required`);
  const normalize=s=>String(s||'').replace(/\s+/gu,' ').trim();
  return expected.map(check=>{
    const source=regions.find(r=>r.id===check.region);
    const inventory=check.exposure==='visible'?capture.text:capture.underlyingDOM;
    const paintMatches=t=>check.exposure==='underlyingDOM'
      ?t.excluded?.includes('panel-covered')&&t.paintLayers?.some(l=>l.kind==='panel'&&l.alpha===1&&l.regions.includes(check.occluderRegion))
      :check.backdropAlpha===undefined||t.paintLayers?.some(l=>l.kind==='backdrop'&&l.alpha===check.backdropAlpha);
    const matches=inventory.filter(t=>source&&t.regions?.includes(check.region)&&t.kind===check.kind&&paintMatches(t)&&(check.exposure!=='visible'||(t.visible===true&&t.excluded?.length===0))&&t.x+t.width>source.x&&t.x<source.x+source.width&&t.y+t.height>source.y&&t.y<source.y+source.height);
    const pass=check.kind==='text'?matches.some(t=>normalize(t.text).includes(normalize(check.text))):matches.length===1&&normalize(matches[0].text)===normalize(check.text);
    return {...check,pass,actual:matches.map(t=>t.text)};
  });
}
