import { auth } from './firebase-config.js';
import {
  signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const errorMsg = document.getElementById('error-msg');
const loginWrap = document.querySelector('.login-form-wrap');
const resetSection = document.getElementById('reset-section');
const registerSection = document.getElementById('register-section');
const registrationPasswordSection = document.getElementById('registration-password-section');

function safeDestination(value) {
  if (!value) return './dashboard.html';
  try {
    const destination = new URL(value, window.location.origin);
    if (destination.origin !== window.location.origin || !destination.pathname.startsWith('/') || destination.pathname.endsWith('/login.html')) {
      return './dashboard.html';
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return './dashboard.html';
  }
}

async function requireAcceptedRegistration(response) {
  if (response.status !== 202) throw new Error('registration-failed');
  const body = await response.json().catch(() => null);
  if (!body || body.status !== 'accepted' || body.state !== 'received'
    || Object.keys(body).length !== 2) throw new Error('registration-failed');
}

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
  if (response.ok) return window.location.replace(safeDestination(new URLSearchParams(location.search).get('next')));
  if (response.status === 401 || response.status === 403) {
    const body = await response.json().catch(() => ({}));
    await signOut(auth);
    const error = new Error(body.error || 'access-denied');
    const reason = ['email-not-verified', 'pending-approval', 'enable-pending', 'account-disabled'].includes(body.reason)
      ? body.reason : response.status === 401 ? 'session' : 'access-denied';
    error.code = `portal/${reason}`;
    throw error;
  }
  throw new Error('api-unavailable');
}

function handleAuthError(err) {
  const messages = {
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
    'auth/user-disabled': 'A conta ainda não está habilitada ou foi desativada. Se você fez um cadastro, aguarde a aprovação.',
    'portal/email-not-verified': 'Confirme seu e-mail antes de entrar no Portal.',
    'portal/pending-approval': 'Cadastro confirmado. Aguarde a aprovação do administrador.',
    'portal/enable-pending': 'Sua conta está aguardando habilitação. Tente novamente em instantes.',
    'portal/account-disabled': 'Conta desativada. Contate o suporte.',
    'portal/session': 'Sua sessão expirou. Entre novamente.',
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
if (reason === 'email') errorMsg.textContent = 'Confirme seu e-mail antes de entrar no Portal.';
if (reason === 'pending-approval') errorMsg.textContent = 'Cadastro confirmado. Aguarde a aprovação do administrador.';
if (reason === 'enable-pending') errorMsg.textContent = 'Sua conta está aguardando habilitação. Tente novamente em instantes.';
if (reason === 'account-disabled') errorMsg.textContent = 'Conta desativada. Contate o suporte.';
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
  registerSection.classList.remove('active');
  registrationPasswordSection.classList.remove('active');
  document.getElementById('reset-email').focus();
});

document.getElementById('registration-password-link').addEventListener('click', () => {
  document.getElementById('login-title').textContent = 'Criar senha do cadastro';
  document.getElementById('login-title').setAttribute('tabindex', '-1');
  document.getElementById('login-title').focus();
  loginWrap.classList.add('hidden');
  resetSection.classList.remove('active');
  registerSection.classList.remove('active');
  registrationPasswordSection.classList.add('active');
  document.getElementById('registration-password-email').focus();
});

document.getElementById('register-link').addEventListener('click', () => {
  document.getElementById('login-title').textContent = 'Cadastre-se';
  document.getElementById('login-title').setAttribute('tabindex', '-1');
  document.getElementById('login-title').focus();
  loginWrap.classList.add('hidden');
  resetSection.classList.remove('active');
  registerSection.classList.add('active');
  registrationPasswordSection.classList.remove('active');
  document.getElementById('register-name').focus();
});

document.getElementById('back-link').addEventListener('click', () => {
  document.getElementById('login-title').textContent = 'Entrar no Portal';
  document.getElementById('login-title').focus();
  resetSection.classList.remove('active');
  registerSection.classList.remove('active');
  registrationPasswordSection.classList.remove('active');
  loginWrap.classList.remove('hidden');
  document.getElementById('reset-error').textContent = '';
  document.getElementById('reset-success').style.display = 'none';
  document.getElementById('reset-email').value = '';
  document.getElementById('reset-btn').disabled = false;
  document.getElementById('reset-btn').textContent = 'Enviar link de redefinição';
});

document.getElementById('registration-password-back-link').addEventListener('click', () => {
  document.getElementById('login-title').textContent = 'Entrar no Portal';
  document.getElementById('login-title').focus();
  registrationPasswordSection.classList.remove('active');
  resetSection.classList.remove('active');
  registerSection.classList.remove('active');
  loginWrap.classList.remove('hidden');
  document.getElementById('registration-password-error').textContent = '';
  document.getElementById('registration-password-success').style.display = 'none';
  document.getElementById('registration-password-section').reset();
  document.getElementById('registration-password-btn').disabled = false;
  document.getElementById('registration-password-btn').textContent = 'Enviar link para criar senha';
});

document.getElementById('register-back-link').addEventListener('click', () => {
  document.getElementById('login-title').textContent = 'Entrar no Portal';
  document.getElementById('login-title').focus();
  registerSection.classList.remove('active');
  resetSection.classList.remove('active');
  loginWrap.classList.remove('hidden');
  document.getElementById('register-error').textContent = '';
  document.getElementById('register-success').style.display = 'none';
  document.getElementById('register-section').reset();
  document.getElementById('register-btn').disabled = false;
  document.getElementById('register-btn').textContent = 'Criar cadastro';
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

registrationPasswordSection.addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const email = document.getElementById('registration-password-email').value.trim();
  const setupError = document.getElementById('registration-password-error');
  const setupSuccess = document.getElementById('registration-password-success');
  const setupBtn = document.getElementById('registration-password-btn');
  setupError.textContent = '';
  setupSuccess.style.display = 'none';
  setupBtn.disabled = true;
  setupBtn.textContent = 'Enviando…';
  try {
    const response = await fetch('/api/auth/registration-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'too-many-requests' : 'delivery-failed');
    setupSuccess.textContent = `Se o cadastro estiver confirmado, o link para criar a senha será enviado para ${email}. Verifique também a pasta de spam.`;
    setupSuccess.style.display = 'block';
    setupBtn.textContent = 'Solicitação recebida';
  } catch (error) {
    setupError.textContent = error.message === 'too-many-requests'
      ? 'Muitas tentativas. Aguarde alguns minutos.'
      : 'Não foi possível enviar agora. Tente novamente.';
    setupBtn.disabled = false;
    setupBtn.textContent = 'Enviar link para criar senha';
  }
});

registerSection.addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const error = document.getElementById('register-error');
  const success = document.getElementById('register-success');
  const button = document.getElementById('register-btn');
  error.textContent = '';
  success.style.display = 'none';
  button.disabled = true;
  button.textContent = 'Enviando…';
  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('register-name').value.trim(),
        email: document.getElementById('register-email').value.trim(),
      }),
    });
    await requireAcceptedRegistration(response);
    success.textContent = 'Se o cadastro puder ser processado, você receberá instruções para confirmar o e-mail. Depois, use “Primeiro acesso: criar senha” para definir sua senha e aguarde a aprovação do administrador.';
    success.style.display = 'block';
    registerSection.reset();
    button.textContent = 'Cadastro recebido';
  } catch {
    error.textContent = 'Não foi possível concluir o cadastro agora. Tente novamente.';
    button.disabled = false;
    button.textContent = 'Criar cadastro';
  }
});
