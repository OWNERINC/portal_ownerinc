import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');

renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

const submitBtn = document.getElementById('o-submit');
const errorEl   = document.getElementById('o-error');
const successEl = document.getElementById('o-success');

submitBtn.addEventListener('click', async () => {
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
  submitBtn.textContent = 'Enviando...';

  try {
    // Grava APENAS categoria e mensagem — sem uid ou email (anônimo)
    await fetchAPI('/api/ombudsman', {
      method: 'POST',
      body: JSON.stringify({ category, message }),
    });

    successEl.style.display = '';
    submitBtn.style.display = 'none';
    document.getElementById('o-message').value = '';
  } catch {
    errorEl.textContent = 'Erro ao enviar. Tente novamente.';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Enviar anonimamente';
  }
});
