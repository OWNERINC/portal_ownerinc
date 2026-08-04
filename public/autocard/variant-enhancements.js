const variantCanvas = document.getElementById('cardCanvas');
const variantTitle = document.getElementById('templateTitle');
const variantFields = document.getElementById('fields');

const themes = {
  editorial: { bg: '#f7f4ef', text: '#141414', secondary: '#625e57', panel: '#e8e2d8', accent: '#c8bdae', border: '#d9d1c5', logo: '/assets/ownerinc-completa-black.webp' },
  noir: { bg: '#111110', text: '#fff', secondary: '#ded7cc', panel: '#2a2925', accent: '#c8bdae', border: '#4a463f', logo: '/assets/ownerinc-completa-white.webp' },
  beige: { bg: '#d9cbb8', text: '#141414', secondary: '#5e554b', panel: '#fffdf9', accent: '#b4a28e', border: '#b9aa96', logo: '/assets/ownerinc-completa-black.webp' },
};

let applying = false;

function selectedVariant() {
  const selected = document.querySelector('[data-mode].active')?.dataset.mode;
  return selected === 'dark' ? 'noir' : selected === 'beige' ? 'beige' : 'editorial';
}

function setImportant(element, property, value) {
  element.style.setProperty(property, value, 'important');
}

function applyVariant() {
  if (applying || !variantCanvas.children.length || !variantTitle.textContent) return;
  applying = true;
  const theme = themes[selectedVariant()];
  variantCanvas.className = `variant-${selectedVariant()}`;
  setImportant(variantCanvas, 'background', theme.bg);
  setImportant(variantCanvas, 'color', theme.text);
  variantCanvas.querySelectorAll('.card-shell').forEach(element => {
    setImportant(element, 'background', theme.bg);
    setImportant(element, 'color', theme.text);
  });
  variantCanvas.querySelectorAll('.card-shell h2, .card-shell .body').forEach(element => setImportant(element, 'color', theme.text));
  variantCanvas.querySelectorAll('.card-kicker, .card-shell .sub, .card-footer, .vacancy-apply, .vacancy-description>span, .vacancy-sections>div>span').forEach(element => setImportant(element, 'color', theme.secondary));
  variantCanvas.querySelectorAll('.highlight, .employee-start, .card-placeholder, .card-illustration, .requirements span').forEach(element => {
    setImportant(element, 'background', theme.panel);
    setImportant(element, 'color', theme.text);
  });
  variantCanvas.querySelectorAll('.accent-bar').forEach(element => setImportant(element, 'background', theme.accent));
  variantCanvas.querySelectorAll('.date-box').forEach(element => {
    setImportant(element, 'background', theme.text);
    setImportant(element, 'color', theme.bg);
  });
  variantCanvas.querySelectorAll('.card-footer, .vacancy-apply').forEach(element => setImportant(element, 'border-color', theme.border));
  variantCanvas.querySelectorAll('.birthday-photo').forEach(element => setImportant(element, 'border-color', theme.accent));
  variantCanvas.querySelectorAll('.card-footer img').forEach(element => {
    element.src = theme.logo;
    element.style.filter = 'none';
  });
  variantCanvas.querySelectorAll('i, svg').forEach(element => setImportant(element, 'color', theme.secondary));
  if (variantTitle.textContent === 'Aniversariante') {
    const size = document.querySelector('[data-size].active')?.dataset.size || 'medium';
    const dimensions = window.matchMedia('(max-width: 500px)').matches
      ? { small: 130, medium: 165, large: 195 }
      : { small: 155, medium: 190, large: 225 };
    const photo = variantCanvas.querySelector('.birthday-photo');
    if (photo) {
      setImportant(photo, 'width', `${dimensions[size]}px`);
      setImportant(photo, 'height', `${dimensions[size]}px`);
      setImportant(photo, 'flex-basis', `${dimensions[size]}px`);
    }
  }
  applying = false;
}

function setupDateMasks() {
  document.querySelectorAll('#field-data, #field-prazo').forEach(field => {
    if (field.dataset.dateMask === 'true') return;
    field.dataset.dateMask = 'true';
    field.inputMode = 'numeric';
    field.placeholder = 'DD/MM';
    field.addEventListener('input', () => {
      const digits = field.value.replace(/\D/g, '').slice(0, 4);
      const formatted = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
      if (field.value !== formatted) {
        field.value = formatted;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });
}

const observer = new MutationObserver(() => {
  setupDateMasks();
  applyVariant();
});
observer.observe(variantCanvas, { childList: true, subtree: true });
observer.observe(variantTitle, { childList: true, characterData: true, subtree: true });
observer.observe(variantFields, { childList: true, subtree: true });
setupDateMasks();
