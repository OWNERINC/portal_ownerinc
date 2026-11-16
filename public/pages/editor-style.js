import { el, button, field } from './dom.js';
import { normalizeHex, resolveAppearance, appearanceIssues, typographyMetrics } from './appearance.js';
import { editV3, upgradeDocument } from './document-v3.js';
import { allBlocks, clone } from './model.js';
import { findBlock, insertAt } from './composition.js';
import { openEditorPanel } from './editor-panels.js';

export const themePalettes = {
  conecta: { label: 'Conecta', colors: ['#2A275E','#E84F1C','#F7F6F2'] },
  editorial: { label: 'Editorial', colors: ['#3C352E','#9E583E','#F0ECE5'] },
  neutro: { label: 'Neutro', colors: ['#262626','#6B7280','#F5F5F5'] },
};
const fonts = { manrope: 'Manrope', 'source-serif-4': 'Source Serif 4', oswald: 'Oswald' };
const scales = { small: 'Texto pequeno · 14 px', standard: 'Texto médio · 16 px', large: 'Texto grande · 19,2 px' };
const aligns = { start: 'À esquerda', center: 'Centralizado', end: 'À direita' };
const icons = { none: 'Sem ícone', info: 'Informação', alert: 'Alerta', check: 'Confirmação', arrow: 'Seta', download: 'Download', play: 'Reproduzir', upload: 'Upload', coffee: 'Café', users: 'Pessoas', headphones: 'Fones', shirt: 'Vestimenta' };
const fills = ['#2A275E','#E84F1C','#F7F6F2','#E8E6EC','#FFFFFF','#F5F5F5'];
const owns = (obj, key) => Object.hasOwn(obj, key);
let panelSequence = 0;
export function styleDefaults(doc) {
  const { font, scale, align, foreground, background, accent } = resolveAppearance(doc);
  return { font, scale, align, palette: doc.schema_version === 3 ? doc.presentation.defaults.palette : 'conecta', foreground, background, accent };
}
export function normalizeDefaults(value) {
  const keys = ['font','scale','align','palette','foreground','background','accent'];
  if (!value || Object.keys(value).length !== keys.length || keys.some(k => !owns(value,k)) || !owns(fonts,value.font) || !owns(scales,value.scale) || !owns(aligns,value.align) || !owns(themePalettes,value.palette)) return null;
  const result = { ...value };
  for (const key of ['foreground','background','accent']) { result[key] = normalizeHex(value[key]); if (!result[key]) return null; }
  return result;
}
export function parseLocalTags(raw) {
  if (typeof raw !== 'string' || raw.includes('\0')) return null;
  if (!raw.trim()) return [];
  const tags = raw.split(',').map(v => v.trim());
  return tags.length <= 20 && tags.every(t => t && t.length <= 40) && new Set(tags).size === tags.length ? tags : null;
}
function validAppearance(value) {
  return value && typeof value==='object' && !Array.isArray(value) && Object.entries(value).every(([key,v]) => {
    if (key === 'font') return owns(fonts,v);
    if (key === 'scale') return owns(scales,v);
    if (key === 'align') return owns(aligns,v);
    if (key === 'icon') return owns(icons,v);
    return ['foreground','background','accent'].includes(key) && (key === 'background' && v === 'none' || normalizeHex(v) === v);
  });
}
// No write/upgrade until a real change exists. Reuse structural accounting after
// conversion, including PM node/link/mark budgets, rather than just checking bytes.
export function styleCandidate(doc, change) {
  const next = editV3(doc, change); if (!next || !normalizeDefaults(next.presentation.defaults)) return null;
  for (const block of allBlocks(next)) {
    if (owns(block,'appearance') && !validAppearance(block.appearance)) return null;
    if (owns(block,'tags') && (!Array.isArray(block.tags) || block.tags.length > 20 || new Set(block.tags).size !== block.tags.length || block.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 40 || t.includes('\0')))) return null;
  }
  const first = allBlocks(next)[0];
  if (!first) return new TextEncoder().encode(JSON.stringify(next)).length <= 1048576 ? next : null;
  const check = clone(next), found = findBlock(check, first.id); found.column.blocks.splice(found.index,1);
  return insertAt(check, { columnId: found.column.id, index: found.index, block: first }) ? next : null;
}
function selectControl(label, options, value, change) {
  const control = el('select', { 'aria-label': label }, ...Object.entries(options).map(([v,text]) => el('option',{value:v,text})));
  control.value = value; control.addEventListener('change', () => change(control.value)); return control;
}
function swatch(color, action, attrs = {}) {
  const control = button('', action, { className: 'btn pages-color-swatch', 'aria-label': color, ...attrs });
  control.style.setProperty('--swatch', color); return control;
}
function contrastText(doc) {
  const issues = appearanceIssues(doc);
  return issues.length ? `Contraste AA insuficiente em ${issues.length} trecho(s) (${Math.min(...issues.map(i=>i.ratio)).toFixed(2)}:1). Revise antes de publicar.` : 'Verifique o contraste antes de publicar.';
}

function afterNativeComposition(control, refresh) {
  // nativeField keeps its global IME lock through the synchronous final input.
  // Run after that queued cleanup, reading the final DOM value into LOCAL UI only.
  control.addEventListener('compositionend',()=>queueMicrotask(()=>queueMicrotask(refresh)));
}

// All fields are a local draft. Optional bindings inject current permissions and
// native IME tracking; onApply returns false to keep the panel open on rejection.
export function openStylePanel({ page, anchor, document: doc, onApply, canAct = () => true, available = true, bindNative, onLegacy }) {
  let draft = styleDefaults(doc), panel, closed = false;
  const prefix=`pages-style-${++panelSequence}`;
  const close = restore => { if (closed) return; closed = true; panel.close(restore); };
  const current = () => !closed && panel?.dialog.isConnected && canAct();
  const content = el('div', { className: 'pages-style-panel-content' });
  const note = el('p', { className: 'pages-panel-help', text: 'Escolha uma base. Você pode ajustar cada bloco depois.' });
  const tabs = el('div',{ className:'pages-style-tabs', role:'tablist','aria-label':'Estilo da página' });
  const body = el('div',{id:`${prefix}-body`,role:'tabpanel','aria-label':'Tema'});
  const font = selectControl('Fonte da página', fonts, draft.font, value => { if (current()) { draft.font = value; refresh(); } });
  const scale = selectControl('Tamanho da página', scales, draft.scale, value => { if (current()) { draft.scale = value; refresh(); } });
  const align = selectControl('Alinhamento da página', aligns, draft.align, value => { if (current()) { draft.align = value; refresh(); } });
  const sample = el('div', { className: 'pages-style-sample' }, el('strong'), el('p',{text:'Clareza em cada detalhe.'}));
  const palettes = el('div',{className:'pages-theme-palettes',role:'group','aria-label':'Paleta da página'});
  for (const [key,value] of Object.entries(themePalettes)) {
    const pick = button('', () => {
      if (!current()) return;
      [draft.foreground,draft.accent,draft.background] = value.colors; draft.palette = key; hex.value = draft.accent; refresh();
    }, {'data-theme-palette':key,'aria-pressed':String(key===draft.palette),disabled:!available});
    for (const color of value.colors) { const dot=el('span',{className:'pages-theme-dot','aria-hidden':'true'}); dot.style.backgroundColor=color; pick.append(dot); }
    pick.append(el('span',{text:value.label}), el('span',{className:'pages-theme-check',text:'✓','aria-hidden':'true'})); palettes.append(pick);
  }
  let scope = 'accent';
  const scopeControl = selectControl('Propriedade da cor', { foreground:'Texto',background:'Fundo',accent:'Destaque' }, scope, value => { if (!current()) return; scope=value; hex.value=draft[scope]; refresh(); });
  const hex = el('input', { value:draft.accent, maxlength:32, 'aria-label':'Cor personalizada de destaque', spellcheck:'false' });
  const warning = el('p',{className:'pages-style-contrast',role:'status'}), invalid=el('p',{id:`${prefix}-invalid`,className:'pages-style-invalid',role:'alert'});
  hex.setAttribute('aria-describedby',`${prefix}-invalid`);
  const apply = button('✓ Aplicar estilo', () => {
    if (!current() || !available || !normalizeHex(hex.value)) return;
    const value = normalizeDefaults({...draft,[scope]:normalizeHex(hex.value)}); if (!value) return;
    if (onApply(value) !== false) close();
  },{className:'btn btn-primary','data-apply-style':''});
  const customLabel = field('Cor personalizada · destaque',hex);
  const syncHex=()=>{if(!current())return;const value=normalizeHex(hex.value);if(value)draft[scope]=value;refresh();};
  hex.addEventListener('input',syncHex);
  afterNativeComposition(hex,syncHex);
  let selected = 'theme';
  const controls = [font,scale,align,scopeControl,hex];
  function refresh() {
    sample.dataset.font=draft.font; sample.querySelector('strong').textContent=`Aa ${fonts[draft.font]}`;
    sample.style.color=draft.foreground; sample.style.backgroundColor=draft.background; sample.style.textAlign=draft.align;
    sample.style.fontSize={small:'14px',standard:'16px',large:'19.2px'}[draft.scale];
    for (const pick of palettes.children) pick.setAttribute('aria-pressed',String(pick.dataset.themePalette===draft.palette));
    const valid=!!normalizeHex(hex.value); hex.setAttribute('aria-invalid',String(!valid));
    const message=valid?'':'Use uma cor hexadecimal #RRGGBB.';
    if(invalid.textContent!==message)invalid.textContent=message;
    apply.disabled=!valid || !canAct() || !available;
    controls.forEach(control=>{control.disabled=!available||!canAct();});
    const preview=upgradeDocument(doc); preview.presentation={theme:'conecta',defaults:{...draft}};
    const contrast=contrastText(preview); if(warning.textContent!==contrast)warning.textContent=contrast;
  }
  function show(tab, focus = false) {
    selected=tab; scope=tab==='colors'?scopeControl.value:'accent'; hex.value=draft[scope];
    hex.setAttribute('aria-label',tab==='colors'?'Cor personalizada':'Cor personalizada de destaque');
    customLabel.firstElementChild.textContent=tab==='colors'?'Cor personalizada':'Cor personalizada · destaque';
    body.setAttribute('aria-label',{theme:'Tema',typography:'Tipografia',colors:'Cores'}[tab]);
    body.setAttribute('aria-labelledby',`${prefix}-${tab}`);
    for (const b of tabs.children) { const active=b.dataset.styleTab===tab; b.setAttribute('aria-selected',String(active)); b.tabIndex=active?0:-1; if(active&&focus)b.focus(); }
    body.replaceChildren(...(tab==='theme'?[field('Fonte',font),sample,el('h3',{text:'Paleta'}),palettes,customLabel]:tab==='typography'?[field('Fonte',font),sample,field('Tamanho',scale),field('Alinhamento',align)]:[field('Propriedade',scopeControl),customLabel,sample])); refresh();
  }
  for (const [key,text] of [['theme','Tema'],['typography','Tipografia'],['colors','Cores']]) tabs.append(button(text,()=>show(key),{id:`${prefix}-${key}`,role:'tab','aria-controls':`${prefix}-body`,'data-style-tab':key}));
  tabs.addEventListener('keydown',event=>{const keys=['theme','typography','colors'],i=keys.indexOf(selected);let next;if(event.key==='ArrowRight')next=keys[(i+1)%3];if(event.key==='ArrowLeft')next=keys[(i+2)%3];if(event.key==='Home')next=keys[0];if(event.key==='End')next=keys[2];if(next){event.preventDefault();show(next,true);}});
  content.append(note,tabs,body,invalid,warning);
  const actions=el('div',{className:'pages-panel-actions'},apply);
  if(!available)content.append(el('p',{role:'status',text:'O servidor não permite escrita v3. Os presets legados continuam disponíveis abaixo.'}));
  if (onLegacy) content.append(el('details',{className:'pages-style-legacy'},el('summary',{text:'Estilo legado dos blocos existentes'}),el('p',{text:'Altera somente os blocos existentes, sem criar herança.'}),button('Abrir presets legados',()=>{if(!current())return;close(false);onLegacy();})));
  panel=openEditorPanel({page,anchor,anchorOffset:10,title:'Estilo da página',content,actions,className:'pages-page-style-panel'});
  // Native close/Escape also retires callbacks, even when a detached control is held.
  panel.dialog.addEventListener('close',()=>{closed=true;});
  for (const control of controls) bindNative?.(control,()=>{if(control===hex)hex.value=draft[scope];else if(control===scopeControl)scopeControl.value=scope;else control.value=draft[control===font?'font':control===scale?'scale':'align'];},()=>!available,()=>!closed&&panel.dialog.isConnected);
  show('theme'); return {close,dialog:panel.dialog};
}

export function createInspector({ document: doc, block, onAppearance, onReset, onTags, onWidth, onAdvanced, canAct=()=>true, available=true, bindNative, nativeMeta=()=>({}) }) {
  let disposed=false;
  const node=el('div',{className:'pages-style-inspector'}), effective=resolveAppearance(doc,block);
  const current=()=>!disposed&&node.isConnected&&canAct();
  const control=(label,options,key)=>{
    const input=selectControl(label,{inherit:block.style?'Remover ajuste (manter estilo legado)':'Usar padrão da página',...options},block.appearance?.[key]||effective[key],value=>{if(!current()||!available){sync();return;}if(onAppearance({[key]:value==='inherit'?null:value})===false)sync();});
    const sync=()=>{input.value=block.appearance?.[key]||effective[key];}; bindNative?.(input,sync,()=>!available,()=>!disposed&&node.isConnected); return field(label,input);
  };
  const textual=block.type!=='divider';
  // Compact typography uses the same atomic appearance callback as the full fields.
  // 16 px is the standard base scale, not a claim that every heading/body uses it.
  if (textual && !['image','gif','gallery'].includes(block.type)) {
    const options = {};
    for (const [font,label] of Object.entries(fonts)) for (const [scale,size] of Object.entries({small:14,standard:16,large:19.2})) options[`${font}:${scale}`] = `${label} · ${size} px`;
    const saved = `${effective.font}:${effective.scale}`;
    const combined = selectControl('Tipografia e tamanho', options, saved, value => {
      const [font,scale] = value.split(':');
      if (!current() || !available || !owns(fonts,font) || !owns(scales,scale) || onAppearance({font,scale}) === false) combined.value = saved;
    });
    combined.title = 'Escala base; o modelo adapta títulos e corpo à superfície.';
    combined.setAttribute('aria-description', combined.title);
    bindNative?.(combined,()=>{combined.value=saved;},()=>!available,()=>!disposed&&node.isConnected);
    const compact = field('Tipografia',combined); compact.classList.add('pages-compact-typography'); node.append(compact);
  }
  if(textual){
    const fixedCaption=['image','gif','gallery'].includes(block.type);
    let size;
    if(fixedCaption){
      const input=selectControl('Tamanho',{'not-applicable':'Não se aplica · legendas em 14 px'},'not-applicable',()=>{input.value='not-applicable';});
      input.disabled=true;bindNative?.(input,()=>{input.value='not-applicable';},()=>true,()=>!disposed&&node.isConnected);size=field('Tamanho',input);
    }else {
      const options=Object.fromEntries(Object.entries(scales).map(([scale,label])=>{
        const candidate={...block,appearance:{...block.appearance,scale}};
        const metrics=typographyMetrics(doc,candidate);
        return [scale,metrics.guide?`Texto do modelo · ${metrics.body} px`:label];
      }));
      size=control('Tamanho',options,'scale');
    }
    node.append(control('Tipografia',fonts,'font'),size,control('Alinhamento',aligns,'align'));
  }
  else node.append(el('p',{text:'Tipografia, tamanho e alinhamento não se aplicam ao separador.'}));
  const savedWidth=findBlock(doc,block.id)?.row.layout==='single'?'full':'half';
  const width=selectControl('Largura do bloco',{full:'Linha inteira',half:'Meia linha'},savedWidth,value=>{if(current())onWidth(value,width);else width.value=savedWidth;});
  const widthField=field('Largura',width);
  bindNative?.(width,()=>{width.value=findBlock(doc,block.id)?.row.layout==='single'?'full':'half';},()=>false,()=>!disposed&&node.isConnected);
  const savedFill=block.appearance?.background||(block.style?effective.background:'inherit');
  const fill=selectControl('Fundo do bloco',{none:'Sem preenchimento',inherit:block.style?'Remover ajuste (manter estilo legado)':doc.presentation?.defaults?.palette==='conecta'?'Padrão Conecta':'Padrão da página',custom:'Cor personalizada',...Object.fromEntries(fills.map(c=>[c,c]))},savedFill,value=>{if(!current()||!available){fill.value=savedFill;return;}if(value==='custom'){hex.focus();fill.value=savedFill;return;}if(onAppearance({background:value==='inherit'?null:value})===false)fill.value=savedFill;});
  if(!fills.includes(savedFill)&&!['none','inherit'].includes(savedFill)){fill.append(el('option',{value:savedFill,text:savedFill}));fill.value=savedFill;}
  const hex=el('input',{value:effective.background,'aria-label':'Cor de fundo personalizada',maxlength:32,spellcheck:'false'});
  const feedback=el('p',{id:`pages-inspector-${++panelSequence}-error`,className:'pages-style-invalid',role:'alert'});
  hex.setAttribute('aria-describedby',feedback.id);
  const reset=()=>{hex.value=effective.background;};bindNative?.(hex,reset,()=>!available,()=>!disposed&&node.isConnected);
  hex.addEventListener('change',()=>{if(!current()||!available){reset();return;}const color=normalizeHex(hex.value);hex.setAttribute('aria-invalid',String(!color));if(!color){feedback.textContent='Use uma cor hexadecimal #RRGGBB.';return;}feedback.textContent='';hex.value=color;if(onAppearance({background:color})===false)reset();});
  bindNative?.(fill,()=>{fill.value=savedFill;},()=>!available,()=>!disposed&&node.isConnected);
  const swatches=el('div',{className:'pages-fill-swatches',role:'group','aria-label':'Cores de fundo'},...fills.map(color=>swatch(color,()=>{if(current()&&available)onAppearance({background:color});},{disabled:!available})));
  const fillField=field('Fundo',fill); fillField.classList.add('pages-shared-fill');
  node.append(fillField,swatches,field('Cor de fundo personalizada',hex),feedback);
  const tags=el('input',{value:(block.tags||[]).join(', '),'aria-label':'Tags do bloco',maxlength:838});
  bindNative?.(tags,()=>{tags.value=(block.tags||[]).join(', ');},()=>!available,()=>!disposed&&node.isConnected);
  tags.addEventListener('change',event=>{if(!current()||!available){tags.value=(block.tags||[]).join(', ');return;}const values=parseLocalTags(tags.value);if(!values){feedback.textContent='Use até 20 tags únicas, não vazias, de 40 caracteres.';tags.value=(block.tags||[]).join(', ');return;}if(onTags(values,nativeMeta(event))===false)tags.value=(block.tags||[]).join(', ');});
  node.append(field('Tags',tags),control('Ícone',icons,'icon'));
  if(onReset)node.append(button(block.style?'Usar padrão da página — substituir cores e tipografia legadas':'Usar padrão da página para este bloco',()=>{if(current()&&available)onReset();},{className:'btn btn-ghost pages-reset-appearance',disabled:!available}));
  if(!available)node.append(el('p',{text:'Personalização v3 indisponível no servidor. Use os presets legados em Estilo.'}));
  node.append(el('p',{className:'pages-style-contrast',role:'status',text:contrastText(doc)}));
  const style=el('section',{className:'pages-inspector-group','data-inspector-section':'style'},el('h3',{text:'Estilo'}),...Array.from(node.children));
  const position=el('section',{className:'pages-inspector-group','data-inspector-section':'position'},el('h3',{text:'Posição'}),widthField);
  // Keep the existing callback/transaction authority; only its host is now flat.
  onAdvanced?.(position);
  node.append(style,position);
  return {node,blockId:block.id,dispose(){disposed=true;}};
}

export function openInlineColorPanel({page,anchor,mark,onApply,canAct=()=>true,bindNative,contrast=()=>''}) {
  let panel,closed=false;
  const current=()=>!closed&&panel?.dialog.isConnected&&canAct();
  const close=restore=>{closed=true;panel.close(restore);};
  const input=el('input',{value:mark==='highlight'?'#F7F6F2':'#2A275E','aria-label':'Cor hexadecimal',maxlength:32,spellcheck:'false'});
  const feedback=el('p',{role:'alert'}),warning=el('p',{className:'pages-style-contrast',role:'status'});
  const applyValue=color=>{if(current()&&onApply(color)!==false)close();};
  const apply=button('Aplicar cor',()=>{const color=normalizeHex(input.value);if(color)applyValue(color);});
  const syncHex=()=>{if(!current())return;const color=normalizeHex(input.value);input.setAttribute('aria-invalid',String(!color));apply.disabled=!color;feedback.textContent=color?'':'Use uma cor hexadecimal #RRGGBB.';warning.textContent=color?contrast(color):'';};
  input.addEventListener('input',syncHex);
  afterNativeComposition(input,syncHex);
  warning.textContent=contrast(input.value);
  const content=el('div',{},field('Hexadecimal',input),el('div',{className:'pages-fill-swatches'},...fills.map(color=>swatch(color,()=>applyValue(color)))),feedback,warning,apply,button('Remover cor',()=>applyValue(null)));
  panel=openEditorPanel({page,anchor,title:mark==='highlight'?'Realce do texto selecionado':'Cor do texto selecionado',content,className:'pages-inline-color-panel'});
  panel.dialog.addEventListener('close',()=>{closed=true;});
  bindNative?.(input,()=>{input.value='';},()=>false,()=>!closed&&panel.dialog.isConnected);
  return {close,dialog:panel.dialog};
}
