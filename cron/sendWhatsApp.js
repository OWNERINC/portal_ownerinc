// WhatsApp via Z-API — DESATIVADO
// Para ativar: configurar ZAPI_TOKEN e ZAPI_INSTANCE nas env vars
// e descomentar as chamadas em checkReminders.js

async function sendWhatsApp({ phone, message }) {
  throw new Error('WhatsApp não está ativado. Configure Z-API e descomente em checkReminders.js.');

  // Implementação futura:
  // const instance = process.env.ZAPI_INSTANCE;
  // const token = process.env.ZAPI_TOKEN;
  // await fetch(`https://api.z-api.io/instances/${instance}/token/${token}/send-text`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ phone, message })
  // });
}

module.exports = { sendWhatsApp };
