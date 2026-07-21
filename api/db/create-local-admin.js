require('dotenv').config();
const { firebaseAuth } = require('../middleware/auth');
const { bootstrapAdmin } = require('./bootstrap-admin');

async function createLocalAdmin(email, password, name) {
  if (process.env.NODE_ENV !== 'development' || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('Local admin creation requires the Firebase Auth Emulator in development');
  }
  if (!email || !password || password.length < 8 || !name) {
    throw new Error('Usage: create-local-admin EMAIL PASSWORD NAME');
  }

  let user;
  try {
    user = await firebaseAuth.getUserByEmail(email);
    user = await firebaseAuth.updateUser(user.uid, { password, displayName: name, emailVerified: true, disabled: false });
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    user = await firebaseAuth.createUser({ email, password, displayName: name, emailVerified: true });
  }
  await bootstrapAdmin(user.uid, email, name);
}

if (require.main === module) {
  createLocalAdmin(...process.argv.slice(2, 5)).catch((error) => {
    console.error(`[local-admin] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createLocalAdmin };
