import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';
import { protectForm } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');

renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

const submitBtn = document.getElementById('o-submit');
const errorEl   = document.getElementById('o-error');
const successEl = document.getElementById('o-success');
const form = document.getElementById('ombudsman-form');
const markFormClean = protectForm(form);

form.addEventListener('submit', async event => {
  event.preventDefault();
  const category = document.getElementById('o-category').value;
  const message  = document.getElementById('o-message').value.trim();

  errorEl.textContent = '';

  if (!message) {
    errorEl.textContent = 'Escreva sua mensagem antes de enviar.';
    return;
  }
  if (message.length < 10) {
    errorEl.textContent = 'Mensagem muito curta. Descreva melhor sua situação.';
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
