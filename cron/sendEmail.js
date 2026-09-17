const { getMailTransport } = require('./mailTransport');

async function sendEmail({ to, subject, text }, env = process.env) {
  const result = await getMailTransport(env).sendMail({ to, from: env.MAILER_SENDER_EMAIL, subject, text });
  return result;
}

module.exports = { sendEmail };
