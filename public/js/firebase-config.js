import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { connectAuthEmulator, getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyDcbMyYtkF2_aOMryI2_WOEgyTQh40s9kI",
  authDomain: "portal-ownerinc.firebaseapp.com",
  projectId: "portal-ownerinc",
  storageBucket: "portal-ownerinc.firebasestorage.app",
  messagingSenderId: "760220039330",
  appId: "1:760220039330:web:a3a4a77290cdc3a6b9fffb"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}
