import { auth } from './firebase-config.js';

try {
  await auth.authStateReady();
  window.location.replace(auth.currentUser ? './dashboard.html' : './login.html');
} catch (_) {
  window.location.replace('./login.html?reason=session');
}
