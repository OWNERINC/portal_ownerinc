const { getMailTransport } = require('./mailTransport');

async function sendOperationalAlert({ subject, text }, env = process.env) {
  if (!env.OPERATIONAL_ALERT_EMAIL) return false;
  try {
    await getMailTransport(env).sendMail({
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

module.exports = { sendOperationalAlert };
