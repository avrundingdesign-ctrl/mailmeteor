/**
 * SMTP-Anbindung.
 *
 * Es wird eine einzige, offen gehaltene Verbindung (`pool`) genutzt und jede
 * Mail einzeln verschickt – ein Empfänger pro Nachricht, kein BCC. Jeder
 * Empfänger sieht damit nur die eigene Adresse.
 */

import nodemailer from 'nodemailer';

/** Bekannte Anbieter, damit in der .env nur User + Passwort stehen müssen. */
const PRESETS = {
  'gmail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
  'googlemail.com': { host: 'smtp.gmail.com', port: 465, secure: true },
  'outlook.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'hotmail.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'web.de': { host: 'smtp.web.de', port: 587, secure: false },
  'gmx.de': { host: 'mail.gmx.net', port: 587, secure: false },
  'gmx.net': { host: 'mail.gmx.net', port: 587, secure: false },
};

function presetFor(user) {
  const domain = String(user).split('@')[1]?.toLowerCase();
  return domain ? PRESETS[domain] : undefined;
}

/**
 * Liest die SMTP-Konfiguration aus Umgebungsvariablen.
 * @param {object} env
 */
export function loadSmtpConfig(env = process.env) {
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;

  const missing = [];
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');

  const preset = presetFor(user) ?? {};
  const host = env.SMTP_HOST?.trim() || preset.host;
  if (!host) missing.push('SMTP_HOST');

  if (missing.length > 0) {
    throw new Error(
      `Zugangsdaten fehlen: ${missing.join(', ')}. Lege eine .env nach dem Muster von .env.example an.`,
    );
  }

  const port = Number(env.SMTP_PORT ?? preset.port ?? 587);
  const secure = env.SMTP_SECURE !== undefined ? env.SMTP_SECURE === 'true' : (preset.secure ?? port === 465);

  return {
    host,
    port,
    secure,
    auth: { user, pass },
    from: env.MAIL_FROM?.trim() || user,
    replyTo: env.MAIL_REPLY_TO?.trim() || undefined,
  };
}

export function createTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    pool: true,
    maxConnections: 1, // sequentiell versenden, nicht parallel
    maxMessages: Infinity,
  });
}

/** Prüft Erreichbarkeit und Login, bevor der erste Empfänger dran ist. */
export async function verifyTransport(transport) {
  await transport.verify();
}
