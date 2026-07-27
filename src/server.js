#!/usr/bin/env node
/**
 * Lokaler Server für die Weboberfläche.
 *
 * Läuft absichtlich nur auf 127.0.0.1: die Oberfläche kann Mails verschicken,
 * sie gehört nicht ins Netz. Es gibt keine Anmeldung – wer den Port erreicht,
 * darf senden.
 */

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './env.js';
import { loadAnyRecipients } from './recipients.js';
import { buildMessage, parseFrontMatter, placeholderNames, stripHtmlComments } from './template.js';
import { SendLog, campaignLogPath } from './log.js';
import { createTransport, loadSmtpConfig, verifyTransport } from './transport.js';
import { sendCampaign } from './sender.js';
import { buildSentIndex, fetchReplies, loadImapConfig } from './inbox.js';
import { ReplyStore, replyStorePath } from './replies.js';
import { askAboutReplies, createClient, loadAssistantConfig } from './assistant.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_DIR = join(ROOT, 'web');
const TEMPLATE_DIR = join(ROOT, 'templates');
const LOG_DIR = join(ROOT, '.mailmeteor');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Obergrenze für einen Anhang-Upload (der Body kommt als base64 im JSON). */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Anfrage zu groß (Anhänge über 25 MB?)');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Baut aus den Angaben der Oberfläche denselben Plan, den auch die CLI erzeugt:
 * Empfängerliste, offene Warteschlange, Template und Absenderdaten.
 */
function buildPlan(payload) {
  const {
    recipientsText = '',
    delimiter,
    subject = '',
    body = '',
    isHtml = true,
    campaign = 'kampagne',
    resend = false,
    only = null,
    from,
    replyTo,
    unsubscribe,
    attachments = [],
  } = payload;

  const list = loadAnyRecipients(recipientsText, { delimiter });
  const cleanBody = isHtml ? stripHtmlComments(body) : body;

  const unknown = placeholderNames(`${subject}\n${cleanBody}`).filter(
    (name) => !list.columns.some((col) => col.toLowerCase() === name.toLowerCase()),
  );

  const log = new SendLog(campaignLogPath(LOG_DIR, campaign));
  const sentBefore = log.sentAddresses();

  let queue = list.recipients;
  let alreadySent = 0;

  if (only) {
    const wanted = String(only).toLowerCase();
    const match = queue.find((r) => r.email.toLowerCase() === wanted);
    queue = [match ?? { email: only, line: 0, fields: { email: only, name: '', vorname: '' } }];
  } else if (!resend) {
    const before = queue.length;
    queue = queue.filter((r) => !sentBefore.has(r.email.toLowerCase()));
    alreadySent = before - queue.length;
  }

  let smtp = null;
  let smtpError = null;
  try {
    smtp = loadSmtpConfig();
  } catch (error) {
    smtpError = error.message;
  }

  const envelope = {
    from: from?.trim() || smtp?.from || '',
    replyTo: replyTo?.trim() || smtp?.replyTo,
    attachments: attachments.length
      ? attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.contentBase64 ?? '', 'base64'),
        }))
      : undefined,
  };
  if (unsubscribe?.trim()) {
    const value = unsubscribe.trim();
    envelope.headers = {
      'List-Unsubscribe': value.startsWith('mailto:') || value.startsWith('<') ? value : `<${value}>`,
    };
  }

  return {
    list,
    queue,
    alreadySent,
    unknown,
    log,
    smtp,
    smtpError,
    envelope,
    template: { subject, body: cleanBody, isHtml },
  };
}

function limitsFrom(payload) {
  const l = payload.limits ?? {};
  const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    delayMs: num(l.delayMs, 3000),
    jitterMs: num(l.jitterMs, 2000),
    retries: num(l.retries, 2),
    retryDelayMs: num(l.retryDelayMs, 5000),
    maxPerRun: num(l.maxPerRun, 0),
  };
}

// ---------------------------------------------------------------------------
// Endpunkte
// ---------------------------------------------------------------------------

/** Zustand beim Laden der Seite: ist SMTP eingerichtet, welche Kampagnen gibt es. */
async function handleState(res) {
  let smtp = null;
  let smtpError = null;
  try {
    smtp = loadSmtpConfig();
  } catch (error) {
    smtpError = error.message;
  }

  let campaigns = [];
  if (existsSync(LOG_DIR)) {
    const files = (await readdir(LOG_DIR)).filter(
      // "antworten-*.jsonl" gehört zum Postfach, nicht zur Kampagnenliste.
      (f) => f.endsWith('.jsonl') && !f.startsWith('antworten-'),
    );
    campaigns = files.map((file) => {
      const log = new SendLog(join(LOG_DIR, file));
      const last = log.entries.at(-1);
      return {
        name: file.replace(/\.jsonl$/, ''),
        ...log.summary(),
        lastAt: last?.at ?? null,
      };
    });
    campaigns.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  }

  let templates = [];
  if (existsSync(TEMPLATE_DIR)) {
    templates = (await readdir(TEMPLATE_DIR)).filter((f) => /\.(html?|txt|md)$/i.test(f));
  }

  // Bewusst nur "eingerichtet ja/nein" plus Fehlertext – weder Passwort noch
  // API-Schlüssel verlassen den Server.
  const capability = (load) => {
    try {
      load();
      return { configured: true };
    } catch (error) {
      return { configured: false, error: error.message };
    }
  };

  json(res, 200, {
    smtp: smtp
      ? { configured: true, from: smtp.from, host: smtp.host, port: smtp.port, user: smtp.auth.user }
      : { configured: false, error: smtpError },
    imap: capability(() => loadImapConfig()),
    assistant: capability(() => loadAssistantConfig()),
    campaigns,
    templates,
  });
}

/** Vorlage aus dem templates-Ordner laden. */
async function handleTemplate(res, name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes('..')) {
    return json(res, 400, { error: 'Ungültiger Vorlagenname' });
  }
  const path = join(TEMPLATE_DIR, name);
  if (!path.startsWith(TEMPLATE_DIR) || !existsSync(path)) {
    return json(res, 404, { error: 'Vorlage nicht gefunden' });
  }
  const { meta, body } = parseFrontMatter(await readFile(path, 'utf8'));
  json(res, 200, {
    subject: meta.subject ?? '',
    body,
    isHtml: /\.html?$/i.test(name),
  });
}

/** Empfänger prüfen und die Mail für einen bestimmten Empfänger rendern. */
async function handleAnalyze(req, res) {
  const payload = await readJsonBody(req);
  const plan = buildPlan(payload);
  const index = Math.min(Math.max(0, Number(payload.previewIndex) || 0), Math.max(0, plan.queue.length - 1));

  const target = plan.queue[index] ?? plan.list.recipients[0] ?? null;
  const preview = target ? buildMessage(plan.template, target) : null;

  json(res, 200, {
    format: plan.list.format,
    columns: plan.list.columns,
    recipients: plan.queue.map((r) => ({ email: r.email, fields: r.fields })),
    totalInList: plan.list.recipients.length,
    alreadySent: plan.alreadySent,
    skipped: plan.list.skipped,
    unknownPlaceholders: plan.unknown,
    smtp: plan.smtp
      ? { configured: true, from: plan.envelope.from }
      : { configured: false, error: plan.smtpError },
    preview: preview
      ? {
          index,
          to: preview.message.to,
          subject: preview.message.subject,
          html: preview.message.html ?? null,
          text: preview.message.text ?? '',
          missing: preview.missing,
        }
      : null,
  });
}

/**
 * Versand mit laufender Rückmeldung.
 *
 * Die Antwort ist ein Strom von JSON-Zeilen (NDJSON). Bricht der Browser die
 * Verbindung ab – Stop-Knopf oder geschlossener Tab – wird auch der Lauf
 * gestoppt, und zwar erst nach der gerade laufenden Mail.
 */
async function handleSend(req, res) {
  const payload = await readJsonBody(req);
  const dryRun = payload.dryRun !== false;
  const plan = buildPlan(payload);
  const limits = limitsFrom(payload);

  if (plan.queue.length === 0) {
    return json(res, 400, { error: 'Keine offenen Empfänger – alle wurden bereits angeschrieben.' });
  }
  if (!dryRun && !plan.smtp) {
    return json(res, 400, { error: plan.smtpError });
  }
  if (!dryRun && !plan.template.subject.trim()) {
    return json(res, 400, { error: 'Ohne Betreff wird nicht versendet.' });
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const emit = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  let transport = null;
  if (!dryRun) {
    transport = createTransport(plan.smtp);
    try {
      await verifyTransport(transport);
    } catch (error) {
      transport.close();
      emit({ type: 'error', message: `SMTP-Login fehlgeschlagen: ${error.message}` });
      return res.end();
    }
  }

  emit({ type: 'start', total: plan.queue.length, dryRun, from: plan.envelope.from });

  try {
    const result = await sendCampaign({
      recipients: plan.queue,
      template: plan.template,
      envelope: plan.envelope,
      transport,
      log: plan.log,
      limits,
      signal: controller.signal,
      hooks: {
        onBeforeSend: ({ recipient, index, missing }) =>
          emit({ type: 'sending', index, email: recipient.email, missing }),
        onSent: ({ recipient, index }) => emit({ type: 'sent', index, email: recipient.email }),
        onFailed: ({ recipient, index, error }) =>
          emit({ type: 'failed', index, email: recipient.email, message: error.message }),
        onRetry: ({ recipient, attempt, retries, wait }) =>
          emit({ type: 'retry', email: recipient.email, attempt, retries, wait }),
        onWait: ({ wait, nextRecipient }) =>
          emit({ type: 'waiting', wait, nextEmail: nextRecipient?.email ?? null }),
      },
    });
    emit({ type: 'done', ...result });
  } catch (error) {
    emit({ type: 'error', message: error.message });
  } finally {
    transport?.close();
    res.end();
  }
}

/** Protokoll einer Kampagne, für die Verlaufsansicht. */
function handleLog(res, campaign) {
  const log = new SendLog(campaignLogPath(LOG_DIR, campaign));
  json(res, 200, { campaign, entries: log.entries, ...log.summary() });
}

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

/** Beginnt eine NDJSON-Antwort und liefert die Sende-Funktion dafür. */
function startStream(req, res) {
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });

  return {
    signal: controller.signal,
    emit: (event) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    },
  };
}

function storeFor(campaign) {
  return new ReplyStore(replyStorePath(LOG_DIR, campaign));
}

/** Gespeicherte Antworten einer Kampagne – ohne den vollen Text. */
function handleReplies(res, campaign) {
  const store = storeFor(campaign);
  json(res, 200, {
    campaign,
    lastSyncAt: store.lastSyncAt(),
    ...store.summary(),
    // Der Volltext bleibt hier weg: die Liste soll schlank laden.
    replies: store.all().map(({ text, html, ...rest }) => rest),
  });
}

/** Eine einzelne Antwort samt vollem Text. */
function handleReply(res, campaign, id) {
  const reply = storeFor(campaign).byId(id);
  if (!reply) return json(res, 404, { error: `Es gibt keine Antwort mit der Nummer ${id}.` });
  json(res, 200, reply);
}

/**
 * Holt die Antworten aus dem Postfach und meldet den Fortschritt laufend.
 *
 * Zugeordnet wird über die beim Versand protokollierte Message-ID, ersatzweise
 * über die Absenderadresse – alles andere im Postfach bleibt unangetastet.
 */
async function handleSync(req, res) {
  const payload = await readJsonBody(req);
  const campaign = payload.campaign || 'kampagne';

  const log = new SendLog(campaignLogPath(LOG_DIR, campaign));
  const sentIndex = buildSentIndex(log.entries);

  let config;
  try {
    config = loadImapConfig();
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
  if (sentIndex.byAddress.size === 0) {
    return json(res, 400, {
      error: `Für "${campaign}" wurde noch nichts versendet – es kann auch nichts zurückkommen.`,
    });
  }

  const { emit, signal } = startStream(req, res);
  const store = storeFor(campaign);

  try {
    const { replies, checked } = await fetchReplies({
      config,
      sentIndex,
      signal,
      onProgress: (event) => emit(event),
    });

    for (const reply of replies) store.upsert(reply);
    store.recordSync({ checked, matched: replies.length });

    emit({ type: 'done', checked, matched: replies.length, ...store.summary() });
  } catch (error) {
    emit({ type: 'error', message: error.message });
  } finally {
    res.end();
  }
}

/** Frage an die KI, Antwort als Strom. */
async function handleChat(req, res) {
  const payload = await readJsonBody(req);
  const campaign = payload.campaign || 'kampagne';

  let client;
  try {
    client = createClient(loadAssistantConfig());
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const replies = storeFor(campaign).all();
  if (replies.length === 0) {
    return json(res, 400, { error: 'Es sind noch keine Antworten abgerufen, die durchsucht werden könnten.' });
  }

  const { emit, signal } = startStream(req, res);

  try {
    await askAboutReplies({
      client,
      replies,
      question: payload.question,
      history: Array.isArray(payload.history) ? payload.history : [],
      signal,
      onEvent: (event) => emit(event),
    });
  } catch (error) {
    emit({ type: 'error', message: error.message });
  } finally {
    res.end();
  }
}

/**
 * Antwortet auf eine Antwort – im selben Gesprächsfaden.
 *
 * In-Reply-To und References sorgen dafür, dass die Mail beim Empfänger unter
 * der ursprünglichen Unterhaltung einsortiert wird und nicht als neue Mail.
 */
async function handleAnswer(req, res) {
  const payload = await readJsonBody(req);
  const campaign = payload.campaign || 'kampagne';
  const store = storeFor(campaign);
  const original = store.byId(payload.id);

  if (!original) return json(res, 404, { error: `Es gibt keine Antwort mit der Nummer ${payload.id}.` });
  if (!payload.text?.trim()) return json(res, 400, { error: 'Ohne Text wird nichts verschickt.' });

  let smtp;
  try {
    smtp = loadSmtpConfig();
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  const transport = createTransport(smtp);
  try {
    await verifyTransport(transport);
    const info = await transport.sendMail({
      from: smtp.from,
      to: original.from.address,
      subject: /^(re|aw):/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
      text: payload.text,
      inReplyTo: `<${original.messageId}>`,
      references: [original.inReplyTo, original.messageId].filter(Boolean).map((id) => `<${id}>`),
    });

    store.markAnswered(original.messageId);
    json(res, 200, { sent: true, to: original.from.address, messageId: info.messageId });
  } catch (error) {
    json(res, 400, { error: `Antwort konnte nicht versendet werden: ${error.message}` });
  } finally {
    transport.close();
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Nicht gefunden');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(await readFile(file));
}

export function createUiServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return await handleState(res);
      if (req.method === 'GET' && url.pathname === '/api/template') {
        return await handleTemplate(res, url.searchParams.get('name') ?? '');
      }
      if (req.method === 'GET' && url.pathname === '/api/log') {
        return handleLog(res, url.searchParams.get('campaign') ?? 'kampagne');
      }
      if (req.method === 'GET' && url.pathname === '/api/replies') {
        return handleReplies(res, url.searchParams.get('campaign') ?? 'kampagne');
      }
      if (req.method === 'GET' && url.pathname === '/api/reply') {
        return handleReply(
          res,
          url.searchParams.get('campaign') ?? 'kampagne',
          url.searchParams.get('id'),
        );
      }
      if (req.method === 'POST' && url.pathname === '/api/replies/sync') return await handleSync(req, res);
      if (req.method === 'POST' && url.pathname === '/api/replies/answer') return await handleAnswer(req, res);
      if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res);
      if (req.method === 'POST' && url.pathname === '/api/analyze') return await handleAnalyze(req, res);
      if (req.method === 'POST' && url.pathname === '/api/send') return await handleSend(req, res);
      if (req.method === 'GET') return await serveStatic(res, url.pathname);
      json(res, 404, { error: 'Unbekannter Endpunkt' });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      json(res, 400, { error: error.message });
    }
  });
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  loadEnvFile();
  const port = Number(process.env.PORT ?? 4000);
  const server = createUiServer();
  server.listen(port, '127.0.0.1', () => {
    const configured = (() => {
      try {
        loadSmtpConfig();
        return true;
      } catch {
        return false;
      }
    })();
    console.log(`\n  mailmeteor läuft auf  http://127.0.0.1:${port}\n`);
    console.log(
      configured
        ? '  SMTP ist eingerichtet – Probelauf und Versand sind möglich.\n'
        : '  Hinweis: keine .env gefunden. Probelauf geht, Versand erst mit Zugangsdaten.\n',
    );
    console.log('  Beenden mit Strg-C\n');
  });
}
