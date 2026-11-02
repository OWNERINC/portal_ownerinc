const net = require('node:net');
const tls = require('node:tls');

let transport;

const RETRYABLE_SMTP_CODES = new Set([421, 450, 451, 452, 454, 471, 472, 473, 503]);
const NETWORK_RETRY_CODES = new Set(['ECONNECTION', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function smtpResponseCode(value) {
  for (const candidate of [value?.responseCode, value?.statusCode, value?.response?.statusCode]) {
    const code = Number(candidate);
    if (Number.isInteger(code) && code >= 200 && code <= 599) return code;
  }
  const response = String(value?.response || '');
  const match = /(?:^|\s)([245]\d{2})(?:\s|$)/.exec(response);
  return match ? Number(match[1]) : null;
}

function classifySmtpCode(code) {
  if (!Number.isInteger(code)) return 'unknown';
  if (RETRYABLE_SMTP_CODES.has(code)) return 'retryable';
  if (code >= 400 && code < 500) return 'retryable';
  if (code >= 500 && code < 600) return 'permanent';
  if (code >= 200 && code < 300) return 'accepted';
  return 'unknown';
}

function acceptedRecipient(value, recipient) {
  return recipientIn(value, 'accepted', recipient);
}

function recipientIn(value, field, recipient) {
  if (!Array.isArray(value?.[field]) || !recipient) return false;
  const target = String(recipient).trim().toLowerCase();
  return value[field].some((candidate) => String(candidate).trim().toLowerCase() === target);
}

function hasContradictoryRecipientState(value, recipient = null) {
  const fields = ['accepted', 'rejected', 'pending'];
  const states = fields.map(field => new Set(
    (Array.isArray(value?.[field]) ? value[field] : [])
      .map(candidate => String(candidate).trim().toLowerCase())
      .filter(Boolean),
  ));
  const targets = recipient
    ? [String(recipient).trim().toLowerCase()]
    : [...new Set(states.flatMap(state => [...state]))];
  return targets.some(target => {
    const matches = states.map(state => state.has(target));
    return (matches[0] && (matches[1] || matches[2])) || (matches[1] && matches[2]);
  });
}

function classifySmtpError(error, recipient = null) {
  // An accepted recipient plus a later transport error is ambiguous, never a safe retry.
  if (hasContradictoryRecipientState(error, recipient) || acceptedRecipient(error, recipient)) return 'unknown';
  const byCode = classifySmtpCode(smtpResponseCode(error));
  if (byCode !== 'unknown' && byCode !== 'accepted') return byCode;
  return NETWORK_RETRY_CODES.has(String(error?.code || '').toUpperCase()) ? 'retryable' : byCode;
}

function classifySmtpResult(result, recipient = null) {
  if (!result) return 'unknown';
  if (hasContradictoryRecipientState(result, recipient)) return 'unknown';
  const hasAccepted = Array.isArray(result.accepted);
  const hasRejected = Array.isArray(result.rejected);
  const byCode = classifySmtpCode(smtpResponseCode(result));
  if (!hasAccepted && !hasRejected) {
    return byCode === 'retryable' || byCode === 'permanent' ? byCode : 'unknown';
  }
  if (acceptedRecipient(result, recipient)) {
    if (byCode === 'retryable') return 'unknown';
    if (byCode === 'permanent') return 'permanent';
    return 'accepted';
  }
  if (byCode === 'retryable' || byCode === 'permanent') return byCode;
  return hasRejected && result.rejected.length ? 'permanent' : 'unknown';
}

function getMailTransport(env = process.env, createTransport = options => require('nodemailer').createTransport(options)) {
  if (transport) return transport;
  const sockets = new Set();
  const secure = Number(env.SMTP_PORT) === 465;
  const options = {
    host: env.SMTP_ADDRESS,
    port: Number(env.SMTP_PORT),
    secure,
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
    tls: { rejectUnauthorized: true },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    // Own the underlying socket so the overall alert deadline can destroy it,
    // including a stalled DATA response or a subsequently STARTTLS-wrapped socket.
    getSocket(_options, callback) {
      const address = { host: env.SMTP_ADDRESS, port: Number(env.SMTP_PORT) };
      const socket = secure ? tls.connect({ ...address, servername: env.SMTP_ADDRESS, rejectUnauthorized: true }) : net.connect(address);
      sockets.add(socket);
      let finished = false;
      const done = (error) => {
        if (finished) return; finished = true;
        if (error) socket.destroy();
        callback(error || null, error ? undefined : { connection: socket, secured: secure });
      };
      socket.once('error', done);
      socket.once(secure ? 'secureConnect' : 'connect', () => done());
      socket.once('close', () => sockets.delete(socket));
      socket.setTimeout(5000, () => { const error = new Error('smtp_timeout'); error.code = 'ETIMEDOUT'; done(error); socket.destroy(); });
    },
  };
  transport = createTransport(options);
  const current = transport;
  const close = current.close.bind(current);
  current.close = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    close();
    if (transport === current) transport = undefined;
  };
  return transport;
}

module.exports = {
  acceptedRecipient,
  classifySmtpCode,
  classifySmtpError,
  classifySmtpResult,
  getMailTransport,
  smtpResponseCode,
};
