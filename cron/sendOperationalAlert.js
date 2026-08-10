const nodemailer = require('nodemailer');

let transport;

function getTransport(env = process.env) {
  if (!env.OPERATIONAL_ALERT_EMAIL) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_ADDRESS,
      port: Number(env.SMTP_PORT),
      secure: String(env.SMTP_PORT) === '465',
      auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
      tls: { rejectUnauthorized: true },
    });
  }
  return transport;
}

async function sendOperationalAlert({ subject, text }, env = process.env) {
  const mailer = getTransport(env);
  if (!mailer) return false;
  try {
    await mailer.sendMail({
      from: env.MAILER_SENDER_EMAIL,
      to: env.OPERATIONAL_ALERT_EMAIL,
      subject: `Portal Ownerinc: ${subject}`,
      text,
    });
    console.log(JSON.stringify({ service: 'cron', event: 'operational_alert_sent', subject }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ service: 'cron', event: 'operational_alert_failed', error: String(error.message || error).slice(0, 300) }));
    return false;
  }
}

module.exports = { getTransport, sendOperationalAlert };
