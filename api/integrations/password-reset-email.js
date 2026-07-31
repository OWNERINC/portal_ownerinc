const nodemailer = require('nodemailer');

function portalSender(rawSender) {
  const value = String(rawSender || '').trim();
  const bracketedAddress = value.match(/<([^<>]+)>/);
  const address = (bracketedAddress ? bracketedAddress[1] : value).trim();

  return { name: 'Portal Interno Ownerinc', address };
}

function smtpOptions(env = process.env) {
  const port = Number(env.SMTP_PORT);
  return {
    host: env.SMTP_ADDRESS,
    port,
    secure: port === 465,
    requireTLS: port !== 465 && env.SMTP_ENABLE_STARTTLS_AUTO !== 'false',
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
    tls: { rejectUnauthorized: env.SMTP_OPENSSL_VERIFY_MODE !== 'none' },
  };
}

function safeLink(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function passwordResetMessage({ to, link, env = process.env }) {
  const escapedLink = safeLink(link);
  return {
    from: portalSender(env.MAILER_SENDER_EMAIL),
    to,
    subject: 'Defina sua senha — Portal Interno Ownerinc',
    text: `Seu acesso ao Portal Interno Ownerinc está pronto. Defina sua senha: ${link}\n\nDepois, entre em https://portal.ownerinc.com.br/login.html`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#20242a"><h2>Defina sua senha do Portal Interno Ownerinc</h2><p>Seu acesso já está pronto.</p><p><a href="${escapedLink}" style="display:inline-block;background:#1f5d46;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px">Definir minha senha</a></p><p>Depois, entre em <strong>portal.ownerinc.com.br</strong>.</p><p>Se você não solicitou este acesso, ignore esta mensagem.</p></div>`,
  };
}

function invitationMessage({ to, name, link, env = process.env }) {
  const escapedLink = safeLink(link);
  const recipient = String(name || '').trim();
  const greeting = recipient ? `Olá, ${recipient}!` : 'Olá!';
  const escapedGreeting = recipient ? `Olá, ${safeLink(recipient)}!` : 'Olá!';
  return {
    from: portalSender(env.MAILER_SENDER_EMAIL),
    to,
    subject: 'Seu convite para o Portal Interno Ownerinc',
    text: `${greeting}\n\nVocê recebeu acesso ao Portal Interno Ownerinc. Defina sua senha pelo link: ${link}\n\nDepois, entre em https://portal.ownerinc.com.br/login.html\n\nSe você não esperava este convite, ignore esta mensagem.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#20242a"><h2>Convite para o Portal Interno Ownerinc</h2><p>${escapedGreeting}</p><p>Você recebeu acesso ao Portal Interno Ownerinc.</p><p><a href="${escapedLink}" style="display:inline-block;background:#1f5d46;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px">Definir minha senha</a></p><p>Depois, entre em <strong>portal.ownerinc.com.br</strong>.</p><p>Se você não esperava este convite, ignore esta mensagem.</p></div>`,
  };
}

let transporter;

async function sendPasswordReset({ to, link, env = process.env }) {
  transporter ||= nodemailer.createTransport(smtpOptions(env));
  return transporter.sendMail(passwordResetMessage({ to, link, env }));
}

async function sendInvitation({ to, name, link, env = process.env }) {
  transporter ||= nodemailer.createTransport(smtpOptions(env));
  return transporter.sendMail(invitationMessage({ to, name, link, env }));
}

module.exports = { invitationMessage, passwordResetMessage, sendInvitation, sendPasswordReset, smtpOptions };
