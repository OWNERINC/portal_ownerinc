const nodemailer = require('nodemailer');

let transport;

function getMailTransport(env = process.env) {
  transport ||= nodemailer.createTransport({
    host: env.SMTP_ADDRESS,
    port: Number(env.SMTP_PORT),
    secure: Number(env.SMTP_PORT) === 465,
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
    tls: { rejectUnauthorized: true },
  });
  return transport;
}

module.exports = { getMailTransport };
