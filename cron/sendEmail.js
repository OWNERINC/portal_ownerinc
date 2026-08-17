const { getMailTransport } = require('./mailTransport');

async function sendEmail({ to, subject, text }, env = process.env) {
  await getMailTransport(env).sendMail({ to, from: env.MAILER_SENDER_EMAIL, subject, text });
  console.log(`[sendEmail] Enviado para ${to}`);
}

module.exports = { sendEmail };
