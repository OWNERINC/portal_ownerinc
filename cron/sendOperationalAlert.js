const { getMailTransport, classifySmtpResult, classifySmtpError, smtpResponseCode } = require('./mailTransport');

async function sendOperationalAlertResult({ subject, text, notificationId }, env = process.env, dependencies = {}) {
  const recipient = env.OPERATIONAL_ALERT_EMAIL;
  if (!recipient) return { status: 'permanent', reason: 'recipient_missing' };
  if (typeof recipient !== 'string' || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(recipient) || recipient.length > 254
    || typeof subject !== 'string' || subject.length > 160 || /[\r\n]/u.test(subject)
    || typeof text !== 'string' || Buffer.byteLength(text) > 8192
    || (notificationId !== undefined && !/^[0-9a-f]{32}$/u.test(notificationId))) return { status: 'permanent', reason: 'mail_config_invalid' };
  let mailer, timer;
  const timeoutMs = dependencies.timeoutMs ?? 20000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) return { status: 'permanent', reason: 'mail_config_invalid' };
  try {
    mailer = (dependencies.getTransport || getMailTransport)(env);
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { try { mailer.close(); } catch { /* Finite result only. */ } resolve(null); }, timeoutMs);
    });
    const attempt = Promise.resolve().then(() => mailer.sendMail({
      from: env.MAILER_SENDER_EMAIL,
      to: recipient,
      subject: `Portal Ownerinc: ${subject}`,
      text,
      ...(notificationId ? { messageId: `<own34-${notificationId}@monitor.ownerinc.invalid>` } : {}),
    })).then(result => ({ result }), error => ({ error }));
    const outcome = await Promise.race([attempt, timeout]);
    if (!outcome) return { status: 'unknown', reason: 'smtp_timeout' };
    if (outcome.error) {
      const classified = classifySmtpError(outcome.error, recipient);
      return { status: ['retryable', 'permanent'].includes(classified) ? classified : 'unknown', reason: 'smtp_failed' };
    }
    const result = outcome.result;
    const code = smtpResponseCode(result);
    const finalResponse = typeof result?.response === 'string' ? /^([245]\d{2})(?:\s|$)/u.exec(result.response) : null;
    const classified = classifySmtpResult(result, recipient);
    const accepted = classified === 'accepted' && code >= 200 && code < 300
      && finalResponse !== null && Number(finalResponse[1]) === code
      && Array.isArray(result?.rejected) && result.rejected.length === 0
      && (!result.pending || (Array.isArray(result.pending) && result.pending.length === 0));
    return { status: accepted ? 'accepted' : ['retryable', 'permanent'].includes(classified) ? classified : 'unknown',
      reason: accepted ? 'smtp_accepted' : 'smtp_unconfirmed' };
  } catch {
    return { status: 'unknown', reason: 'smtp_failed' };
  } finally {
    clearTimeout(timer);
    // Health/monitor processes own this transport; no connection survives a send.
    try { mailer?.close(); } catch { /* Never retain a private transport error. */ }
  }
}

async function sendOperationalAlert(message, env = process.env) {
  const result = await sendOperationalAlertResult(message, env);
  const accepted = result.status === 'accepted';
  const record = { service: 'cron', event: accepted ? 'operational_alert_sent' : 'operational_alert_failed',
    status: result.status, reason: result.reason };
  if (accepted) {
    console.log(JSON.stringify(record));
  } else {
    console.error(JSON.stringify(record));
  }
  return accepted;
}

module.exports = { sendOperationalAlert, sendOperationalAlertResult };
