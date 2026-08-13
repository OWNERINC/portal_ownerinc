const cardCanvas = document.getElementById('cardCanvas');
const templateTitle = document.getElementById('templateTitle');
let rendering = false;
let ignoreMutation = false;

const escapeValue = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const value = id => document.getElementById(`field-${id}`)?.value || '';
const list = id => value(id).split('\n').map(item => item.trim()).filter(Boolean).slice(0, 4);

function renderVacancy() {
  if (rendering || ignoreMutation || templateTitle.textContent !== 'Vaga / Recrutamento') return;
  rendering = true;
  ignoreMutation = true;
  const dark = document.querySelector('[data-mode="dark"].active');
  const theme = dark
    ? { bg: '#171716', header: '#282722', text: '#fff', subtext: '#d6bd8b', accent: '#c9a86a', muted: '#302e28' }
    : { bg: '#f6f1e9', header: '#1d1d1b', text: '#171716', subtext: '#746653', accent: '#b99a61', muted: '#e8e0d4' };
  const requirements = list('requisitos').map(item => `<span style="background:${theme.muted}">${escapeValue(item)}</span>`).join('');
  const benefits = list('beneficios').map(item => `<span style="background:${theme.muted}">${escapeValue(item)}</span>`).join('');
  const iconMarkup = document.getElementById('iconPreview')?.innerHTML || '';
  cardCanvas.innerHTML = `<div class="card-shell vacancy-card" style="background:${theme.bg};color:${theme.text}">
    <div class="card-pad">
      <div class="card-kicker" style="color:${theme.subtext}">${iconMarkup} VAGA / RECRUTAMENTO</div>
      <h2>${escapeValue(value('titulo')) || 'Cargo'}</h2>
      <p class="sub" style="color:${theme.subtext}">${escapeValue(value('subtitulo'))}</p>
      <div class="vacancy-description"><span style="color:${theme.accent}">SOBRE A POSIÇÃO</span><p>${escapeValue(value('descricao')) || 'Descreva a missão e o dia a dia da posição.'}</p></div>
      <div class="vacancy-sections">
        <div><span style="color:${theme.accent}">REQUISITOS</span><div class="requirements">${requirements || `<span style="background:${theme.muted}">Adicione os requisitos</span>`}</div></div>
        <div><span style="color:${theme.accent}">BENEFÍCIOS</span><div class="requirements">${benefits || `<span style="background:${theme.muted}">Adicione os benefícios</span>`}</div></div>
      </div>
      <div class="vacancy-apply" style="border-color:${theme.muted};color:${theme.subtext}"><strong>Candidate-se</strong><span>${escapeValue(value('prazo'))}</span><span>${escapeValue(value('contato'))}</span></div>
      <div class="card-footer" style="border-color:${theme.muted};color:${theme.subtext}"><span>Faça parte da Ownerinc</span><img src="${dark ? '/assets/ownerinc-completa-white.webp' : '/assets/ownerinc-completa-black.webp'}" alt="Ownerinc" style="filter:none"></div>
    </div>
  </div>`;
  window.__autocardApplyMediaCropStyle?.();
  window.lucide?.createIcons?.();
  rendering = false;
  setTimeout(() => { ignoreMutation = false; }, 0);
}

function renderEmployee() {
  if (rendering || ignoreMutation || templateTitle.textContent !== 'Novo funcionário') return;
  rendering = true;
  ignoreMutation = true;
  const dark = document.querySelector('[data-mode="dark"].active');
  const theme = dark
    ? { bg: '#171716', text: '#fff', subtext: '#d6bd8b', accent: '#c9a86a', muted: '#302e28' }
    : { bg: '#f6f1e9', text: '#171716', subtext: '#746653', accent: '#b99a61', muted: '#e8e0d4' };
  const photoElement = cardCanvas.querySelector('.card-media');
  const photo = photoElement?.src;
  const photoStyle = photoElement?.getAttribute('style') || '';
  const iconMarkup = document.getElementById('iconPreview')?.innerHTML || '';
  cardCanvas.innerHTML = `<div class="card-shell employee-card" style="background:${theme.bg};color:${theme.text}">
    <div class="employee-layout">
      <div class="employee-photo">${photo ? `<img src="${photo}" style="${photoStyle}" alt="Foto de ${escapeValue(value('titulo'))}">` : iconMarkup}</div>
      <div class="employee-copy">
        <div class="card-kicker" style="color:${theme.subtext}">${iconMarkup} NOVO FUNCIONÁRIO</div>
        <h2>${escapeValue(value('titulo')) || 'Nome do colaborador'}</h2>
        <p class="sub" style="color:${theme.subtext}">${escapeValue(value('subtitulo'))}</p>
        <div class="employee-start" style="background:${theme.muted};color:${theme.subtext}"><span>INÍCIO</span><strong>${escapeValue(value('data')) || 'Data de início'}</strong></div>
        <p class="body">${escapeValue(value('corpo')) || 'Dê as boas-vindas à nova pessoa do time.'}</p>
        <div class="card-footer" style="border-color:${theme.muted};color:${theme.subtext}"><span>Bem-vindo(a) à Ownerinc</span><img src="${dark ? '/assets/ownerinc-completa-white.webp' : '/assets/ownerinc-completa-black.webp'}" alt="Ownerinc" style="filter:none"></div>
      </div>
    </div>
  </div>`;
  window.__autocardApplyMediaCropStyle?.();
  window.lucide?.createIcons?.();
  rendering = false;
  setTimeout(() => { ignoreMutation = false; }, 0);
}

const observer = new MutationObserver(() => { renderVacancy(); renderEmployee(); });
observer.observe(cardCanvas, { childList: true, subtree: true });
observer.observe(templateTitle, { childList: true, characterData: true, subtree: true });
observer.observe(document.getElementById('fields'), { childList: true, subtree: true });
