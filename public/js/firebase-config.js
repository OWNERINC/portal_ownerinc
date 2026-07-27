import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { connectAuthEmulator, getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyA02-GIg0OxfaPyShgiZzTvkjCbhTAT2t8",
  authDomain: "ownerinc-portal-interno-prod.firebaseapp.com",
  projectId: "ownerinc-portal-interno-prod",
  storageBucket: "ownerinc-portal-interno-prod.firebasestorage.app",
  messagingSenderId: "787678489614",
  appId: "1:787678489614:web:7db467b36584fcf6aa605f"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}
