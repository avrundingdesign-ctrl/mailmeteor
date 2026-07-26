#!/usr/bin/env node
/**
 * mailmeteor – Serienmails an viele Empfänger, einzeln versendet.
 *
 * Sicherheitsnetz: Ohne --send passiert nichts außer einer Vorschau.
 */

import { basename, extname, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';

import { loadRecipients } from './recipients.js';
import { buildMessage, parseFrontMatter, placeholderNames, stripHtmlComments } from './template.js';
import { SendLog, campaignLogPath } from './log.js';
import { createTransport, loadSmtpConfig, verifyTransport } from './transport.js';
import { sendCampaign } from './sender.js';
import { loadEnvFile as readEnvFile } from './env.js';

const HELP = `mailmeteor – Serienmails an viele Empfänger, einzeln versendet (kein BCC)

Verwendung:
  mailmeteor --to <liste.csv> --template <datei> [--subject "..."] [--send]

Pflichtangaben:
  --to, --recipients <datei>   CSV mit einer Spalte "email"; weitere Spalten
                               sind im Template als {{spalte}} verfügbar
  --template <datei>           .html wird als HTML verschickt, sonst als Text

Inhalt:
  --subject "<text>"           Betreff (Platzhalter erlaubt). Alternativ im
                               Kopfblock des Templates: "subject: ..."
  --text <datei>               eigene Text-Variante zum HTML-Template
  --attach <datei>             Anhang, mehrfach angebbar
  --from "Name <a@b.de>"       überschreibt MAIL_FROM
  --reply-to <adresse>         Antwortadresse
  --unsubscribe <url|mailto>   setzt den List-Unsubscribe-Header

Versand:
  --send                       wirklich versenden (ohne: nur Vorschau)
  --delay <ms>                 Pause zwischen zwei Mails (Standard 3000)
  --jitter <ms>                zufälliger Aufschlag auf die Pause (Standard 2000)
  --max <n>                    höchstens n Mails in diesem Lauf
  --retries <n>                Wiederholversuche pro Mail (Standard 2)
  --retry-delay <ms>           Wartezeit vor dem ersten Neuversuch (Standard 5000)
  --yes                        Rückfrage vor dem Versand überspringen

Auswahl und Protokoll:
  --limit <n>                  nur die ersten n Empfänger der Liste
  --only <adresse>             nur diese eine Adresse (Testmail)
  --campaign <name>            Name des Protokolls (Standard: Template-Name)
  --log-dir <ordner>           Ablage der Protokolle (Standard .mailmeteor)
  --resend                     bereits zugestellte Adressen erneut anschreiben
  --delimiter <zeichen>        CSV-Trennzeichen erzwingen
  -h, --help                   diese Hilfe

Beispiele:
  mailmeteor --to kunden.csv --template templates/example.html
  mailmeteor --to kunden.csv --template templates/example.html --only ich@example.com --send
  mailmeteor --to kunden.csv --template templates/example.html --send
`;

const OPTIONS = {
  to: { type: 'string' },
  recipients: { type: 'string' },
  template: { type: 'string' },
  subject: { type: 'string' },
  text: { type: 'string' },
  attach: { type: 'string', multiple: true },
  from: { type: 'string' },
  'reply-to': { type: 'string' },
  unsubscribe: { type: 'string' },
  send: { type: 'boolean', default: false },
  delay: { type: 'string' },
  jitter: { type: 'string' },
  max: { type: 'string' },
  retries: { type: 'string' },
  'retry-delay': { type: 'string' },
  yes: { type: 'boolean', default: false },
  limit: { type: 'string' },
  only: { type: 'string' },
  campaign: { type: 'string' },
  'log-dir': { type: 'string' },
  resend: { type: 'boolean', default: false },
  delimiter: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: paint(2),
  bold: paint(1),
  green: paint(32),
  red: paint(31),
  yellow: paint(33),
  cyan: paint(36),
};

function fail(message) {
  console.error(`${c.red('Fehler:')} ${message}`);
  process.exit(1);
}

function number(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`--${name} erwartet eine Zahl, bekam "${value}"`);
  return parsed;
}

function readFileOrFail(path, label) {
  const full = resolve(path);
  if (!existsSync(full)) fail(`${label} nicht gefunden: ${full}`);
  return readFileSync(full, 'utf8');
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    // Ohne Terminal kann nicht gefragt werden – lieber abbrechen als ungefragt senden.
    fail('Keine interaktive Eingabe möglich. Für den Versand ohne Rückfrage: --yes');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [j/N] `);
    return /^(j|ja|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function loadEnvFile() {
  try {
    readEnvFile();
  } catch (error) {
    fail(`.env konnte nicht gelesen werden: ${error.message}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  } catch (error) {
    fail(`${error.message}\n\n${HELP}`);
  }
  const args = parsed.values;

  if (args.help || argv.length === 0) {
    console.log(HELP);
    return 0;
  }

  const listPath = args.to ?? args.recipients;
  if (!listPath) fail('--to <liste.csv> fehlt.');
  if (!args.template) fail('--template <datei> fehlt.');

  // ---- Template laden -----------------------------------------------------
  const templateSource = readFileOrFail(args.template, 'Template');
  const { meta, body: rawBody } = parseFrontMatter(templateSource);
  const isHtml = ['.html', '.htm'].includes(extname(args.template).toLowerCase());
  const body = isHtml ? stripHtmlComments(rawBody) : rawBody;
  const subject = args.subject ?? meta.subject;
  if (!subject) {
    fail('Kein Betreff. Nutze --subject "..." oder einen Kopfblock mit "subject: ..." im Template.');
  }

  const template = {
    subject,
    body,
    isHtml,
    textBody: args.text ? readFileOrFail(args.text, 'Text-Template') : undefined,
  };

  // ---- Empfänger laden ----------------------------------------------------
  let list;
  try {
    list = loadRecipients(readFileOrFail(listPath, 'Empfängerliste'), { delimiter: args.delimiter });
  } catch (error) {
    fail(error.message);
  }

  for (const entry of list.skipped) {
    console.log(`${c.yellow('übersprungen')} ${c.dim(`Zeile ${entry.line}:`)} ${entry.reason}`);
  }

  const unknown = placeholderNames(`${subject}\n${body}`).filter(
    (name) => !list.columns.some((col) => col.toLowerCase() === name.toLowerCase()),
  );
  if (unknown.length > 0) {
    console.log(
      `${c.yellow('Achtung:')} Platzhalter ohne passende Spalte: ${unknown.join(', ')} ${c.dim(
        `(vorhandene Spalten: ${list.columns.join(', ')})`,
      )}`,
    );
  }

  // ---- Filter: --only / --resend / --limit --------------------------------
  const campaign = args.campaign ?? basename(args.template).replace(/\.[^.]+$/, '');
  const logDir = args['log-dir'] ?? '.mailmeteor';
  const log = new SendLog(campaignLogPath(logDir, campaign));

  let queue = list.recipients;

  if (args.only) {
    const wanted = args.only.toLowerCase();
    queue = queue.filter((r) => r.email.toLowerCase() === wanted);
    if (queue.length === 0) {
      queue = [{ email: args.only, line: 0, fields: { email: args.only } }];
      console.log(c.dim(`${args.only} steht nicht in der Liste – Testmail ohne Platzhalterdaten.`));
    }
  }

  let alreadySent = 0;
  if (!args.resend && !args.only) {
    const sent = log.sentAddresses();
    const before = queue.length;
    queue = queue.filter((r) => !sent.has(r.email.toLowerCase()));
    alreadySent = before - queue.length;
  }

  if (args.limit !== undefined) {
    queue = queue.slice(0, number(args.limit, queue.length, 'limit'));
  }

  // ---- Absender / Anhänge ------------------------------------------------
  let smtp = null;
  try {
    smtp = loadSmtpConfig();
  } catch (error) {
    if (args.send) fail(error.message);
    console.log(c.dim(`Hinweis: ${error.message}`));
  }

  const attachments = (args.attach ?? []).map((path) => {
    const full = resolve(path);
    if (!existsSync(full) || !statSync(full).isFile()) fail(`Anhang nicht gefunden: ${full}`);
    return { filename: basename(full), path: full };
  });

  const envelope = {
    from: args.from ?? smtp?.from ?? '(MAIL_FROM nicht gesetzt)',
    replyTo: args['reply-to'] ?? smtp?.replyTo,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
  if (args.unsubscribe) {
    const value = args.unsubscribe.startsWith('mailto:') || args.unsubscribe.startsWith('<')
      ? args.unsubscribe
      : `<${args.unsubscribe}>`;
    envelope.headers = { 'List-Unsubscribe': value };
  }

  const limits = {
    delayMs: number(args.delay, 3000, 'delay'),
    jitterMs: number(args.jitter, 2000, 'jitter'),
    retries: number(args.retries, 2, 'retries'),
    retryDelayMs: number(args['retry-delay'], 5000, 'retry-delay'),
    maxPerRun: args.max === undefined ? 0 : number(args.max, 0, 'max'),
  };

  // ---- Übersicht ---------------------------------------------------------
  console.log('');
  console.log(`${c.bold('Kampagne')}   ${campaign}`);
  console.log(`${c.bold('Absender')}   ${envelope.from}`);
  console.log(`${c.bold('Betreff')}    ${subject}`);
  console.log(`${c.bold('Format')}     ${isHtml ? 'HTML + Text-Variante' : 'Nur Text'}`);
  console.log(
    `${c.bold('Empfänger')}  ${queue.length}` +
      (alreadySent > 0 ? c.dim(` (${alreadySent} laut Protokoll schon zugestellt)`) : '') +
      (list.skipped.length > 0 ? c.dim(` (${list.skipped.length} übersprungen)`) : ''),
  );
  console.log(
    `${c.bold('Takt')}       alle ${(limits.delayMs / 1000).toFixed(1)}–${(
      (limits.delayMs + limits.jitterMs) / 1000
    ).toFixed(1)} s` + (limits.maxPerRun ? c.dim(` · max. ${limits.maxPerRun} in diesem Lauf`) : ''),
  );
  console.log(`${c.bold('Protokoll')}  ${join(logDir, `${campaign}.jsonl`)}`);
  console.log('');

  if (queue.length === 0) {
    console.log(c.green('Nichts zu tun – alle Empfänger wurden bereits angeschrieben.'));
    return 0;
  }

  // ---- Vorschau ----------------------------------------------------------
  if (!args.send) {
    const preview = buildMessage(template, queue[0]);
    console.log(c.dim('── Vorschau der ersten Mail ──────────────────────────'));
    console.log(`An:      ${preview.message.to}`);
    console.log(`Betreff: ${preview.message.subject}`);
    console.log('');
    console.log((preview.message.text ?? '').split('\n').slice(0, 25).join('\n'));
    console.log(c.dim('──────────────────────────────────────────────────────'));
    if (preview.missing.length > 0) {
      console.log(`${c.yellow('Leere Platzhalter:')} ${preview.missing.join(', ')}`);
    }
    console.log('');
    console.log(`${c.cyan('Probelauf.')} Es wurde nichts versendet. Zum echten Versand: ${c.bold('--send')}`);
    console.log(c.dim('Vorher empfohlen: --only deine@adresse.de --send  (eine Testmail an dich selbst)'));
    return 0;
  }

  // ---- Echter Versand ----------------------------------------------------
  if (!args.yes) {
    const ok = await confirm(
      `${queue.length} Mail(s) jetzt einzeln von ${envelope.from} versenden?`,
    );
    if (!ok) {
      console.log('Abgebrochen.');
      return 1;
    }
  }

  const transport = createTransport(smtp);
  try {
    await verifyTransport(transport);
  } catch (error) {
    transport.close();
    fail(`SMTP-Login fehlgeschlagen: ${error.message}`);
  }

  const started = Date.now();
  let result;
  try {
    result = await sendCampaign({
      recipients: queue,
      template,
      envelope,
      transport,
      log,
      limits,
      hooks: {
        onSent: ({ recipient, index, total }) =>
          console.log(`${c.green('✓')} ${c.dim(`[${index + 1}/${total}]`)} ${recipient.email}`),
        onFailed: ({ recipient, error, index, total }) =>
          console.log(`${c.red('✗')} ${c.dim(`[${index + 1}/${total}]`)} ${recipient.email} – ${error.message}`),
        onRetry: ({ recipient, attempt, retries, wait }) =>
          console.log(
            c.yellow(
              `  ↻ ${recipient.email}: Versuch ${attempt}/${retries} in ${Math.round(wait / 1000)} s`,
            ),
          ),
      },
    });
  } finally {
    transport.close();
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log('');
  console.log(
    `${c.bold('Fertig')} in ${seconds} s: ${c.green(`${result.sent} versendet`)}` +
      (result.failed > 0 ? `, ${c.red(`${result.failed} fehlgeschlagen`)}` : '') +
      (result.skipped > 0 ? `, ${result.skipped} offen` : ''),
  );
  if (result.stopReason) console.log(c.yellow(`Abbruch: ${result.stopReason}`));
  if (result.failed > 0) {
    console.log(
      c.dim(`Details im Protokoll. Erneuter Aufruf schickt nur an die noch offenen Adressen.`),
    );
  }

  return result.failed > 0 ? 1 : 0;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  loadEnvFile();
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(c.red(`Unerwarteter Fehler: ${error.stack ?? error.message}`));
      process.exit(1);
    });
}
