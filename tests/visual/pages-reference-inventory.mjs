// Runs unchanged inside Chrome, also exercised by the small browser negative suite.
// Text-node ranges exclude descendant control/option text from labels by construction.
export function referenceInventory() {
  const rows=[],normalize=s=>String(s||'').replace(/\s+/gu,' ').trim();
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
  const painted=n=>{for(let a=n;a;a=a.parentElement){const s=getComputedStyle(a);if(Number(s.opacity)===0||s.visibility!=='visible'||s.display==='none')return false;}return true;};
  const alpha=s=>{
    if(s.visibility!=='visible'||s.display==='none')return 0;
    if(s.backgroundImage!=='none')return 1; // complex paint is conservative
    const channels=s.backgroundColor.match(/[\d.]+/g)?.map(Number)||[];
    return (channels.length===4?channels[3]:channels.length===3?1:0)*Number(s.opacity);
  };
  const modals=[...document.querySelectorAll('dialog[open]')].filter(n=>n.matches(':modal')&&painted(n));
  function record(node,text,kind,rects,resolveGlyphRects) {
    if(!normalize(text)||!rects.length)return;
    const excluded=new Set(),regions=new Set(),occluders=[],clippers=[],paintLayers=[];
    const blockingModals=modals.filter(dialog=>!dialog.contains(node));
    let glyphRects;
    // Native modality makes the rest of the document inert to hit testing. That
    // is interaction blocking, not full-viewport paint. Use actual panel bounds
    // and computed backdrop paint for these single-dialog reference scenes.
    for(const dialog of blockingModals){
      const b=dialog.getBoundingClientRect(),panelAlpha=alpha(getComputedStyle(dialog)),backdropAlpha=alpha(getComputedStyle(dialog,'::backdrop'));
      const provenance={tag:dialog.tagName,className:dialog.className,regions:dialog.__referenceRegions||[]};
      paintLayers.push({...provenance,kind:'backdrop',alpha:backdropAlpha});
      if(backdropAlpha===1){excluded.add('opaque-backdrop');occluders.push({...provenance,kind:'backdrop'});}
      const intersects=r=>r.width>0&&r.height>0&&r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top;
      // A run rectangle is an envelope: a high accent at its left must not make
      // lower letters at its right look covered. Refine only possible panel
      // intersections to glyph ink bounds, without moving or hiding any DOM.
      const possible=rects.some(intersects);
      if(possible&&resolveGlyphRects)glyphRects??=resolveGlyphRects();
      if(possible&&(glyphRects||rects).some(intersects)){
        paintLayers.push({...provenance,kind:'panel',alpha:panelAlpha,bounds:{x:b.x,y:b.y,width:b.width,height:b.height}});
        if(panelAlpha===1){excluded.add('panel-covered');occluders.push({...provenance,kind:'panel'});}
      }
    }
    for(let a=node;a;a=a.parentElement){
      for(const region of a.__referenceRegions||[])regions.add(region);
      const s=getComputedStyle(a);
      if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0||a.hidden)excluded.add('hidden');
      if(a.tagName==='DETAILS'&&!a.open&&!a.querySelector(':scope > summary')?.contains(node))excluded.add('closed-details');
      if(s.clipPath!=='none'||(s.clip!=='auto'&&s.clip!==''))excluded.add('css-clip');
    }
    for(const r of rects){
      if(r.width<=0||r.height<=0||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)excluded.add('viewport-clipped');
      for(let a=node.parentElement;a;a=a.parentElement){
        const s=getComputedStyle(a),b=a.getBoundingClientRect();
        if(/hidden|clip|auto|scroll/.test(s.overflowX)&&(r.left<b.left+a.clientLeft-.5||r.right>b.left+a.clientLeft+a.clientWidth+.5))excluded.add('ancestor-clipped');
        if(/hidden|clip|auto|scroll/.test(s.overflowY)&&(r.top<b.top+a.clientTop-.5||r.bottom>b.top+a.clientTop+a.clientHeight+.5)){excluded.add('ancestor-clipped');clippers.push({tag:a.tagName,className:a.className,top:b.top+a.clientTop,bottom:b.top+a.clientTop+a.clientHeight});}
      }
      // Outside a modal, hit-test results are suppressed by inertness, even when
      // its backdrop is transparent. Paint geometry above owns that case. Inside
      // the panel (or with no modal), retain ordinary sampled paint hit tests.
      if(blockingModals.length)continue;
      for(const fx of [.05,.5,.95]){
        const hit=document.elementsFromPoint(r.left+r.width*fx,r.top+r.height/2).find(painted);
        if(!hit||node!==hit){excluded.add('occluded');occluders.push({tag:hit?.tagName,className:hit?.className});}
      }
    }
    const x=Math.min(...rects.map(r=>r.left)),y=Math.min(...rects.map(r=>r.top));
    const s=getComputedStyle(node);
    rows.push({tag:node.tagName,name:node.getAttribute('aria-label'),kind,text:normalize(text),regions:[...regions],visible:excluded.size===0,excluded:[...excluded],
      overlay:node.closest('dialog')?.className||null,inspector:!!node.closest('.pages-v2-inspector'),x,y,width:Math.max(...rects.map(r=>r.right))-x,height:Math.max(...rects.map(r=>r.bottom))-y,
      clippers,occluders,paintLayers,glyphRects:glyphRects?.map(r=>({text:r.text,x:r.left,y:r.top,width:r.width,height:r.height})),interactionBlocked:blockingModals.length>0,occlusionMethod:blockingModals.length?'modal-paint-geometry':'sampled-hit-test',rects:rects.map(r=>({x:r.left,y:r.top,width:r.width,height:r.height})),font:s.fontFamily,size:s.fontSize,color:s.color,background:s.backgroundColor,disabled:node.disabled||node.getAttribute('aria-disabled')==='true'});
  }
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){
    const text=walker.currentNode,node=text.parentElement;
    if(!node||node.closest('script,style,select,option,datalist,textarea,svg'))continue;
    const range=document.createRange();range.selectNodeContents(text);
    // Range includes font ascent/descent whitespace, which can extend outside a
    // tight line-height even while every glyph is painted. Clip/test the ink's
    // vertical bounds, derived from Chrome's metrics, not relaxed tolerances.
    const s=getComputedStyle(node);context.font=`${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const metrics=context.measureText(text.textContent);
    const rects=[...range.getClientRects()].map(r=>{
      const baseline=r.bottom-metrics.fontBoundingBoxDescent;
      const top=Math.max(r.top,baseline-metrics.actualBoundingBoxAscent),bottom=Math.min(r.bottom,baseline+metrics.actualBoundingBoxDescent);
      return {left:r.left,right:r.right,top,bottom,width:r.width,height:bottom-top};
    });
    record(node,text.textContent,'text',rects,()=>{
      const glyphs=[];
      for(const {segment,index}of new Intl.Segmenter('pt-BR',{granularity:'grapheme'}).segment(text.textContent)){
        const m=context.measureText(segment),part=document.createRange();
        part.setStart(text,index);part.setEnd(text,index+segment.length);
        for(const r of part.getClientRects()){
          const baseline=r.bottom-m.fontBoundingBoxDescent,left=r.left-m.actualBoundingBoxLeft,right=r.left+m.actualBoundingBoxRight;
          const top=baseline-m.actualBoundingBoxAscent,bottom=baseline+m.actualBoundingBoxDescent;
          glyphs.push({text:segment,left,right,top,bottom,width:right-left,height:bottom-top});
        }
      }
      return glyphs;
    });
  }
  for(const node of document.querySelectorAll('select,input:not([type=checkbox]):not([type=radio]),textarea')){
    record(node,node.tagName==='SELECT'?node.selectedOptions[0]?.text:node.value,node.tagName==='SELECT'?'selected-value':'input-value',[node.getBoundingClientRect()]);
  }
  return {text:rows.filter(r=>r.visible),underlyingDOM:rows};
}
