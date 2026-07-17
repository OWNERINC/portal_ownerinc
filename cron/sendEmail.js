const sgMail = require('@sendgrid/mail');

async function sendEmail({ to, subject, text }) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const msg = {
    to,
    from: process.env.SENDGRID_FROM_EMAIL || 'portal@ownerinc.com.br',
    subject,
    text
  };
  try {
    await sgMail.send(msg);
    console.log(`[sendEmail] Enviado para ${to}`);
  } catch (err) {
    console.error(`[sendEmail] Falha para ${to}:`, err.message);
    throw err;
  }
}

module.exports = { sendEmail };
