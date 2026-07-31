import { requireAuth, fetchAPI } from './auth.js';
import { protectForm } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');


const submitBtn = document.getElementById('o-submit');
const errorEl   = document.getElementById('o-error');
const successEl = document.getElementById('o-success');
const form = document.getElementById('ombudsman-form');
const markFormClean = protectForm(form);
const messageField = document.getElementById('o-message');

messageField.addEventListener('input', () => {
  messageField.removeAttribute('aria-invalid');
  errorEl.textContent = '';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const category = document.getElementById('o-category').value;
  const message  = document.getElementById('o-message').value.trim();

  errorEl.textContent = '';

  if (!message) {
    messageField.setAttribute('aria-invalid', 'true');
    errorEl.textContent = 'Escreva sua mensagem antes de enviar.';
    messageField.focus();
    return;
  }
  if (message.length < 10) {
    messageField.setAttribute('aria-invalid', 'true');
    errorEl.textContent = 'Mensagem muito curta. Descreva melhor sua situação.';
    messageField.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Enviando…';

  try {
    await fetchAPI('/api/ombudsman', {
      method: 'POST',
      body: JSON.stringify({ category, message }),
    });

    successEl.style.display = '';
    submitBtn.style.display = 'none';
    document.getElementById('o-message').value = '';
    markFormClean();
  } catch {
    errorEl.textContent = 'Não foi possível enviar. Verifique sua conexão e tente novamente.';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Enviar mensagem';
  }
});
