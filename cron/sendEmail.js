const sgMail = require('@sendgrid/mail');

async function sendEmail({ to, subject, text }) {
  await sgMail.send({ to, from: process.env.SENDGRID_FROM_EMAIL, subject, text });
  console.log(`[sendEmail] Enviado para ${to}`);
}

module.exports = { sendEmail };
