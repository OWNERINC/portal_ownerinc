import { auth } from './firebase-config.js';
import { safeDestination } from './portal-destination.js';
import {
  signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const errorMsg = document.getElementById('error-msg');
const loginWrap = document.querySelector('.login-form-wrap');
const resetSection = document.getElementById('reset-section');
const registerSection = document.getElementById('register-section');
const loginTitle = document.getElementById('login-title');
let registrationPending = false;

function clearRegistrationPasswords() {
  document.getElementById('register-password').value = '';
  document.getElementById('register-password-confirm').value = '';
}

function showView(view, focusTarget) {
  if (registrationPending) return;
  if (view !== 'register') clearRegistrationPasswords();
  const titles = { reset: 'Redefinir senha', register: 'Cadastre-se' };
  loginWrap?.classList.toggle('hidden', view !== 'login');
  for (const [name, section] of [['reset', resetSection], ['register', registerSection]]) {
    section?.classList.toggle('active', view === name);
  }
  if (loginTitle) {
    loginTitle.hidden = view === 'login';
    loginTitle.textContent = titles[view] || '';
  }
  const target = focusTarget || loginTitle;
  if (target) target.focus();
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
  const uid = auth.currentUser.uid;
  const token = await auth.currentUser.getIdToken();
  if (auth.currentUser?.uid !== uid) throw new Error('session-changed');
  let response;
  try {
    response = await fetch('/api/users/me', { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error('api-unavailable');
  }
  if (auth.currentUser?.uid !== uid) throw new Error('session-changed');
  if (response.ok) {
    const user = await response.json();
    if (auth.currentUser?.uid !== uid || user.uid !== uid) throw new Error('session-changed');
    const destination = safeDestination(new URLSearchParams(location.search).get('next'));
    return window.location.replace(user.ethics_accepted === true
      ? destination : `./ethics.html?${new URLSearchParams({ next: destination })}`);
  }
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
    'portal/email-not-verified': 'Não foi possível liberar o acesso. Contate o suporte.',
    'portal/pending-approval': 'Cadastro recebido. Aguarde a aprovação do administrador.',
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
if (reason === 'email') errorMsg.textContent = 'Não foi possível liberar o acesso. Contate o suporte.';
if (reason === 'pending-approval') errorMsg.textContent = 'Cadastro recebido. Aguarde a aprovação do administrador.';
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
  showView('reset');
});

document.getElementById('register-link').addEventListener('click', () => {
  showView('register');
});

document.getElementById('back-link').addEventListener('click', () => {
  showView('login', document.getElementById('forgot-link'));
  document.getElementById('reset-error').textContent = '';
  document.getElementById('reset-success').style.display = 'none';
  document.getElementById('reset-email').value = '';
  document.getElementById('reset-btn').disabled = false;
  document.getElementById('reset-btn').textContent = 'Enviar link de redefinição';
});

document.getElementById('register-back-link').addEventListener('click', () => {
  if (registrationPending) return;
  showView('login', document.getElementById('register-link'));
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

registerSection.addEventListener('invalid', clearRegistrationPasswords, true);
registerSection.addEventListener('submit', async event => {
  event.preventDefault();
  if (registrationPending) return;
  const error = document.getElementById('register-error');
  const success = document.getElementById('register-success');
  const button = document.getElementById('register-btn');
  error.textContent = '';
  success.style.display = 'none';
  const password = document.getElementById('register-password').value;
  const confirmation = document.getElementById('register-password-confirm').value;
  if (password.length < 12 || password.length > 128 || !password.trim() || password !== confirmation) {
    error.textContent = password !== confirmation ? 'As senhas precisam ser iguais.' : 'Use de 12 a 128 caracteres na senha, não apenas espaços.';
    clearRegistrationPasswords();
    document.getElementById('register-password').focus();
    return;
  }
  if (!event.currentTarget.reportValidity()) {
    clearRegistrationPasswords();
    return;
  }
  registrationPending = true;
  const controls = registerSection.querySelectorAll('input, button');
  controls.forEach(control => { control.disabled = true; });
  button.textContent = 'Enviando…';
  let submitted = false;
  clearRegistrationPasswords();
  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('register-name').value.trim(),
        email: document.getElementById('register-email').value.trim(),
        password,
      }),
    });
    await requireAcceptedRegistration(response);
    success.textContent = 'Se o cadastro puder ser processado, aguarde a aprovação do administrador. Quando seu acesso for liberado, entre com o email e a senha escolhida no cadastro.';
    success.style.display = 'block';
    registerSection.reset();
    button.textContent = 'Cadastro recebido';
    submitted = true;
  } catch {
    error.textContent = 'Não foi possível concluir o cadastro agora. Tente novamente.';
    button.textContent = 'Criar cadastro';
  } finally {
    clearRegistrationPasswords();
    registrationPending = false;
    controls.forEach(control => { control.disabled = false; });
    button.disabled = submitted;
  }
});
