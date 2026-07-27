/**
 * Postfach lesen (IMAP) und eingehende Mails der Kampagne zuordnen.
 *
 * SMTP verschickt nur – was zurückkommt, landet im normalen Postfach. Hier
 * wird es geholt und den versendeten Mails zugeordnet.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/** IMAP-Server der Anbieter, für die schon SMTP voreingestellt ist. */
const PRESETS = {
  'gmail.com': { host: 'imap.gmail.com', port: 993 },
  'googlemail.com': { host: 'imap.gmail.com', port: 993 },
  'outlook.com': { host: 'outlook.office365.com', port: 993 },
  'hotmail.com': { host: 'outlook.office365.com', port: 993 },
  'web.de': { host: 'imap.web.de', port: 993 },
  'gmx.de': { host: 'imap.gmx.net', port: 993 },
  'gmx.net': { host: 'imap.gmx.net', port: 993 },
};

/**
 * Liest die IMAP-Zugangsdaten. Standardmäßig dieselben wie für SMTP – bei
 * Gmail funktioniert dasselbe App-Passwort für beides.
 */
export function loadImapConfig(env = process.env) {
  const user = env.IMAP_USER?.trim() || env.SMTP_USER?.trim();
  const pass = env.IMAP_PASS || env.SMTP_PASS;

  const missing = [];
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');

  const domain = String(user).split('@')[1]?.toLowerCase();
  const preset = (domain ? PRESETS[domain] : undefined) ?? {};
  const host = env.IMAP_HOST?.trim() || preset.host;
  if (!host) missing.push('IMAP_HOST');

  if (missing.length > 0) {
    throw new Error(
      `Für den Abruf fehlen: ${missing.join(', ')}. Bei eigenem Anbieter zusätzlich IMAP_HOST in der .env setzen.`,
    );
  }

  const port = Number(env.IMAP_PORT ?? preset.port ?? 993);
  return {
    host,
    port,
    secure: env.IMAP_SECURE !== undefined ? env.IMAP_SECURE === 'true' : port === 993,
    auth: { user, pass },
    mailbox: env.IMAP_MAILBOX?.trim() || 'INBOX',
  };
}

/** Message-IDs einheitlich schreiben: ohne spitze Klammern, klein. */
function normalizeMessageId(value) {
  return String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
}

/**
 * Baut aus dem Versandprotokoll das Nachschlagewerk für die Zuordnung.
 *
 * @param {Array<object>} entries Einträge aus SendLog
 * @returns {{byMessageId: Map<string, string>, byAddress: Set<string>, firstSentAt: string|null}}
 */
export function buildSentIndex(entries) {
  const byMessageId = new Map();
  const byAddress = new Set();
  let firstSentAt = null;

  for (const entry of entries) {
    if (entry.status !== 'sent' || !entry.email) continue;
    const email = entry.email.toLowerCase();
    byAddress.add(email);
    if (entry.messageId) byMessageId.set(normalizeMessageId(entry.messageId), email);
    if (entry.at && (firstSentAt === null || entry.at < firstSentAt)) firstSentAt = entry.at;
  }

  return { byMessageId, byAddress, firstSentAt };
}

/**
 * Erkennt Abwesenheitsnotizen und andere Automaten.
 *
 * Sie werden nicht weggeworfen – sonst fehlt eine Adresse in der Übersicht,
 * obwohl sie geantwortet hat – sondern nur gekennzeichnet.
 */
export function looksAutomatic(headers = {}, subject = '') {
  const get = (name) => {
    const value = headers instanceof Map ? headers.get(name) : headers[name];
    return String(value ?? '').toLowerCase();
  };

  if (get('auto-submitted').startsWith('auto-')) return true;
  if (get('x-autoreply') === 'yes' || get('x-autorespond')) return true;
  if (get('precedence') === 'auto_reply') return true;

  // Betreffzeilen der gängigen Mailprogramme. Bewusst am Anfang verankert,
  // damit "Frage zur Automatischen Abrechnung" nicht fälschlich anschlägt.
  return /^(?:(?:re|aw|antwort|fwd?|wg)\s*:\s*)*(automatische antwort|automatic reply|out of office|abwesenheit|autoreply)/i.test(
    String(subject ?? '').trim(),
  );
}

/**
 * Ordnet eine eingegangene Mail einer versendeten Kampagnenmail zu.
 *
 * Zwei Wege, in dieser Reihenfolge:
 *  1. In-Reply-To / References enthalten die Message-ID unserer Mail – eindeutig.
 *  2. Der Absender steht als Empfänger im Protokoll – fängt Leute ab, die eine
 *     neue Mail schreiben statt auf „Antworten" zu klicken.
 *
 * @returns {{email: string, matchedBy: 'message-id'|'address'}|null}
 */
export function matchReplyToCampaign(parsed, sentIndex) {
  const references = [];
  if (parsed.inReplyTo) references.push(parsed.inReplyTo);
  if (Array.isArray(parsed.references)) references.push(...parsed.references);
  else if (parsed.references) references.push(parsed.references);

  for (const raw of references) {
    // Ein einzelnes Feld kann mehrere IDs enthalten: "<a@x> <b@y>"
    for (const candidate of String(raw).split(/\s+/)) {
      const id = normalizeMessageId(candidate);
      const email = id && sentIndex.byMessageId.get(id);
      if (email) return { email, matchedBy: 'message-id' };
    }
  }

  const from = parsed.from?.value?.[0]?.address ?? parsed.from?.address;
  const address = String(from ?? '').trim().toLowerCase();
  if (address && sentIndex.byAddress.has(address)) return { email: address, matchedBy: 'address' };

  return null;
}

/** Kürzt einen Text auf die ersten Zeilen und schneidet zitierte Passagen ab. */
export function snippetOf(text, max = 400) {
  const withoutQuotes = String(text ?? '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/^\s*Am .+ schrieb .+:\s*$/gim, '')
    .replace(/^\s*On .+ wrote:\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return withoutQuotes.length > max ? `${withoutQuotes.slice(0, max).trimEnd()} …` : withoutQuotes;
}

/** Formt eine zerlegte Mail in den Datensatz, der gespeichert wird. */
export function normalizeReply(parsed, match) {
  const from = parsed.from?.value?.[0] ?? {};
  return {
    messageId: normalizeMessageId(parsed.messageId),
    inReplyTo: normalizeMessageId(parsed.inReplyTo) || null,
    from: { name: from.name ?? '', address: (from.address ?? '').toLowerCase() },
    recipient: match.email,
    matchedBy: match.matchedBy,
    subject: parsed.subject ?? '(kein Betreff)',
    date: (parsed.date ?? new Date()).toISOString(),
    text: parsed.text ?? '',
    html: parsed.html || null,
    snippet: snippetOf(parsed.text ?? ''),
    isAutomatic: looksAutomatic(parsed.headers, parsed.subject),
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? 'anhang',
      size: a.size ?? 0,
    })),
  };
}

/**
 * Holt die Antworten auf eine Kampagne aus dem Postfach.
 *
 * Es wird nur ab dem Zeitpunkt der ersten versendeten Mail gesucht – alles
 * davor kann keine Antwort sein und muss nicht übertragen werden.
 *
 * @param {object} options
 * @param {object} options.config aus loadImapConfig
 * @param {object} options.sentIndex aus buildSentIndex
 * @param {Date} [options.since] überschreibt den Startzeitpunkt
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} [options.onProgress]
 * @returns {Promise<{replies: Array<object>, checked: number}>}
 */
export async function fetchReplies({ config, sentIndex, since, signal, onProgress }) {
  if (sentIndex.byAddress.size === 0) {
    throw new Error('Für diese Kampagne ist noch nichts versendet worden – es kann auch nichts zurückkommen.');
  }

  // Einen Tag Puffer: Zeitzonen und Serveruhren gehen auseinander.
  const start = since ?? new Date(Date.parse(sentIndex.firstSentAt ?? Date.now()) - 24 * 60 * 60 * 1000);

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    logger: false,
  });

  const replies = [];
  let checked = 0;

  await client.connect();
  onProgress?.({ type: 'connected', host: config.host, mailbox: config.mailbox });

  const lock = await client.getMailboxLock(config.mailbox);
  try {
    for await (const message of client.fetch({ since: start }, { source: true })) {
      if (signal?.aborted) break;
      checked++;

      const parsed = await simpleParser(message.source);
      const match = matchReplyToCampaign(parsed, sentIndex);
      if (!match) continue;

      const reply = normalizeReply(parsed, match);
      replies.push(reply);
      onProgress?.({ type: 'match', email: reply.from.address, subject: reply.subject });

      if (checked % 25 === 0) onProgress?.({ type: 'progress', checked, matched: replies.length });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return { replies, checked };
}
