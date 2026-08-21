import { auth } from './firebase-config.js';
import {
  signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const errorMsg = document.getElementById('error-msg');
const loginWrap = document.querySelector('.login-form-wrap');
const resetSection = document.getElementById('reset-section');

document.getElementById('toggle-pw').addEventListener('click', event => {
  const input = document.getElementById('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  event.currentTarget.setAttribute('aria-pressed', String(show));
  event.currentTarget.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  event.currentTarget.querySelector('.icon use').setAttribute('href', `./assets/icons.svg#${show ? 'eye-off' : 'eye'}`);
});

function setAllDisabled(disabled) {
  document.getElementById('submit-btn').disabled = disabled;
}

async function enterPortal() {
  const token = await auth.currentUser.getIdToken();
  let response;
  try {
    response = await fetch('/api/users/me', { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error('api-unavailable');
  }
  if (response.ok) return window.location.replace('./dashboard.html');
  if (response.status === 401 || response.status === 403) {
    await signOut(auth);
    const error = new Error('access-denied');
    error.code = 'portal/access-denied';
    throw error;
  }
  throw new Error('api-unavailable');
}

function handleAuthError(err) {
  const messages = {
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
    'auth/user-disabled': 'Conta desativada. Contate o suporte.',
    'portal/access-denied': 'Esta conta não está autorizada no Portal. Solicite acesso ao administrador.',
  };
  errorMsg.textContent = messages[err.code] ?? (err.message === 'api-unavailable'
    ? 'O Portal está indisponível. Verifique sua conexão e tente novamente.'
    : 'Não foi possível entrar. Tente novamente.');
  setAllDisabled(false);
}

await auth.authStateReady();
const reason = new URLSearchParams(location.search).get('reason');
if (reason === 'access') errorMsg.textContent = 'Esta conta não está autorizada no Portal. Solicite acesso ao administrador.';
if (reason === 'session') errorMsg.textContent = 'Sua sessão expirou. Entre novamente.';
if (auth.currentUser) {
  setAllDisabled(true);
  enterPortal().catch(handleAuthError);
}

document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const btn = document.getElementById('submit-btn');
  setAllDisabled(true);
  btn.textContent = 'Entrando…';
  errorMsg.textContent = '';
  try {
    await signInWithEmailAndPassword(auth, document.getElementById('email').value.trim(), document.getElementById('password').value);
    await enterPortal();
  } catch (err) {
    handleAuthError(err);
    btn.textContent = 'Entrar no portal';
  }
});

document.getElementById('forgot-link').addEventListener('click', () => {
  document.getElementById('login-title').textContent = 'Redefinir senha';
  document.getElementById('login-title').setAttribute('tabindex', '-1');
  document.getElementById('login-title').focus();
  loginWrap.classList.add('hidden');
  resetSection.classList.add('active');
  document.getElementById('reset-email').focus();
});

document.getElementById('back-link').addEventListener('click', () => {
  document.getElementById('login-title').textContent = 'Entrar no Portal';
  document.getElementById('login-title').focus();
  resetSection.classList.remove('active');
  loginWrap.classList.remove('hidden');
  document.getElementById('reset-error').textContent = '';
  document.getElementById('reset-success').style.display = 'none';
  document.getElementById('reset-email').value = '';
  document.getElementById('reset-btn').disabled = false;
  document.getElementById('reset-btn').textContent = 'Enviar link de redefinição';
});

resetSection.addEventListener('submit', async event => {
  event.preventDefault();
  const email = document.getElementById('reset-email').value.trim();
  const resetError = document.getElementById('reset-error');
  const resetSuccess = document.getElementById('reset-success');
  const resetBtn = document.getElementById('reset-btn');
  resetError.textContent = '';
  resetSuccess.style.display = 'none';
  if (!email) {
    resetError.textContent = 'Informe seu e-mail.';
    return;
  }
  resetBtn.disabled = true;
  resetBtn.textContent = 'Enviando…';
  try {
    const response = await fetch('/api/auth/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'too-many-requests' : 'delivery-failed');
    resetSuccess.textContent = `Se a conta estiver ativa, o link será enviado para ${email}. Verifique também a pasta de spam.`;
    resetSuccess.style.display = 'block';
    resetBtn.textContent = 'Solicitação recebida';
  } catch (err) {
    resetError.textContent = err.message === 'too-many-requests'
      ? 'Muitas tentativas. Aguarde alguns minutos.'
      : 'Não foi possível enviar agora. Tente novamente.';
    resetBtn.disabled = false;
    resetBtn.textContent = 'Enviar link de redefinição';
  }
});
