import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';

import {
  buildSentIndex,
  loadImapConfig,
  looksAutomatic,
  matchReplyToCampaign,
  normalizeReply,
  snippetOf,
} from '../src/inbox.js';

const sentLog = [
  { status: 'sent', email: 'anna@example.com', messageId: '<abc123@mailmeteor>', at: '2026-07-01T10:00:00.000Z' },
  { status: 'sent', email: 'Bernd@Example.com', messageId: '<def456@mailmeteor>', at: '2026-07-01T10:00:05.000Z' },
  { status: 'failed', email: 'kaputt@example.com', error: '550' },
];

// --- Zugangsdaten ----------------------------------------------------------

test('IMAP nutzt die SMTP-Zugangsdaten und die Voreinstellung des Anbieters', () => {
  const config = loadImapConfig({ SMTP_USER: 'a@gmail.com', SMTP_PASS: 'app-passwort' });
  assert.equal(config.host, 'imap.gmail.com');
  assert.equal(config.port, 993);
  assert.equal(config.secure, true);
  assert.equal(config.auth.pass, 'app-passwort');
  assert.equal(config.mailbox, 'INBOX');
});

test('eigene IMAP-Angaben schlagen die Voreinstellung', () => {
  const config = loadImapConfig({
    SMTP_USER: 'a@gmail.com',
    SMTP_PASS: 'x',
    IMAP_HOST: 'mail.eigene.de',
    IMAP_PORT: '143',
    IMAP_MAILBOX: 'Posteingang',
  });
  assert.equal(config.host, 'mail.eigene.de');
  assert.equal(config.port, 143);
  assert.equal(config.secure, false, 'Port 143 ist unverschlüsselt');
  assert.equal(config.mailbox, 'Posteingang');
});

test('unbekannter Anbieter verlangt IMAP_HOST', () => {
  assert.throws(() => loadImapConfig({ SMTP_USER: 'a@eigene.de', SMTP_PASS: 'x' }), /IMAP_HOST/);
});

// --- Nachschlagewerk aus dem Versandprotokoll -------------------------------

test('buildSentIndex sammelt nur zugestellte Mails', () => {
  const index = buildSentIndex(sentLog);
  assert.equal(index.byMessageId.get('abc123@mailmeteor'), 'anna@example.com');
  assert.ok(index.byAddress.has('bernd@example.com'), 'Adressen werden kleingeschrieben');
  assert.ok(!index.byAddress.has('kaputt@example.com'), 'Fehlversuche zählen nicht');
  assert.equal(index.firstSentAt, '2026-07-01T10:00:00.000Z');
});

// --- Zuordnung -------------------------------------------------------------

test('Antwort wird über In-Reply-To eindeutig zugeordnet', () => {
  const match = matchReplyToCampaign(
    { inReplyTo: '<abc123@mailmeteor>', from: { value: [{ address: 'privat@gmx.de' }] } },
    buildSentIndex(sentLog),
  );
  assert.deepEqual(match, { email: 'anna@example.com', matchedBy: 'message-id' });
});

test('Zuordnung findet die ID auch in References mit mehreren Einträgen', () => {
  const match = matchReplyToCampaign(
    { references: ['<fremd@x.de> <def456@mailmeteor>'], from: { value: [{ address: 'wer@anders.de' }] } },
    buildSentIndex(sentLog),
  );
  assert.deepEqual(match, { email: 'bernd@example.com', matchedBy: 'message-id' });
});

test('ohne Bezugs-ID greift die Absenderadresse', () => {
  const match = matchReplyToCampaign(
    { from: { value: [{ address: 'ANNA@example.com' }] } },
    buildSentIndex(sentLog),
  );
  assert.deepEqual(match, { email: 'anna@example.com', matchedBy: 'address' });
});

test('fremde Mail wird nicht zugeordnet', () => {
  const match = matchReplyToCampaign(
    { inReplyTo: '<voellig@fremd>', from: { value: [{ address: 'newsletter@shop.de' }] } },
    buildSentIndex(sentLog),
  );
  assert.equal(match, null);
});

// --- Automatische Antworten ------------------------------------------------

test('looksAutomatic erkennt die üblichen Kopfzeilen', () => {
  assert.ok(looksAutomatic({ 'auto-submitted': 'auto-replied' }, 'Re: Kurze Frage'));
  assert.ok(looksAutomatic({ 'x-autoreply': 'yes' }, 'Re: Kurze Frage'));
  assert.ok(looksAutomatic({ precedence: 'auto_reply' }, 'Re: Kurze Frage'));
});

test('looksAutomatic erkennt die üblichen Betreffzeilen', () => {
  assert.ok(looksAutomatic({}, 'Automatische Antwort: Kurze Frage'));
  assert.ok(looksAutomatic({}, 'AW: Automatische Antwort: Kurze Frage'));
  assert.ok(looksAutomatic({}, 'Out of Office'));
  assert.ok(looksAutomatic({}, 'Abwesenheit bis 12.08.'));
});

test('looksAutomatic schlägt bei echten Antworten nicht an', () => {
  assert.ok(!looksAutomatic({}, 'Re: Frage zur automatischen Abrechnung'));
  assert.ok(!looksAutomatic({}, 'Ja, wir haben noch Plätze frei'));
  assert.ok(!looksAutomatic({ 'auto-submitted': 'no' }, 'Re: Kurze Frage'));
});

test('looksAutomatic versteht auch eine Header-Map (mailparser)', () => {
  assert.ok(looksAutomatic(new Map([['auto-submitted', 'auto-generated']]), 'Re: Test'));
});

// --- Auszug ----------------------------------------------------------------

test('snippetOf entfernt den zitierten Ursprungstext', () => {
  const text = [
    'Ja, wir haben noch zwei Plätze frei.',
    '',
    'Am 01.07.2026 schrieb Max Mustermann:',
    '> Hallo, gibt es noch freie Plätze?',
    '> Viele Grüße',
  ].join('\n');
  assert.equal(snippetOf(text), 'Ja, wir haben noch zwei Plätze frei.');
});

test('snippetOf kürzt lange Texte', () => {
  const snippet = snippetOf('x'.repeat(600), 100);
  assert.ok(snippet.length <= 102);
  assert.ok(snippet.endsWith('…'));
});

// --- Echte Mails zerlegen --------------------------------------------------

const echteAntwort = [
  'From: "Müller, Anna" <anna@example.com>',
  'To: max@example.com',
  'Subject: =?UTF-8?Q?Re=3A_Kurze_Frage_zu_Pl=C3=A4tzen?=',
  'Date: Wed, 02 Jul 2026 09:15:00 +0200',
  'Message-ID: <antwort-1@example.com>',
  'In-Reply-To: <abc123@mailmeteor>',
  'References: <abc123@mailmeteor>',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Hallo Max,',
  '',
  'ja, wir haben noch drei Stellplätze frei – für Größen bis 8 m.',
  '',
  '> Gibt es noch etwas frei?',
  '',
].join('\r\n');

const abwesenheit = [
  'From: Bernd Muster <bernd@example.com>',
  'To: max@example.com',
  'Subject: Automatische Antwort: Kurze Frage',
  'Date: Wed, 02 Jul 2026 09:20:00 +0200',
  'Message-ID: <auto-1@example.com>',
  'In-Reply-To: <def456@mailmeteor>',
  'Auto-Submitted: auto-replied',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Ich bin bis zum 15.08. nicht erreichbar.',
  '',
].join('\r\n');

test('eine echte Antwort wird vollständig übernommen', async () => {
  const parsed = await simpleParser(echteAntwort);
  const index = buildSentIndex(sentLog);
  const match = matchReplyToCampaign(parsed, index);
  const reply = normalizeReply(parsed, match);

  assert.equal(reply.messageId, 'antwort-1@example.com');
  assert.equal(reply.inReplyTo, 'abc123@mailmeteor');
  assert.equal(reply.from.address, 'anna@example.com');
  assert.equal(reply.from.name, 'Müller, Anna');
  assert.equal(reply.subject, 'Re: Kurze Frage zu Plätzen', 'kodierter Betreff wird dekodiert');
  assert.equal(reply.recipient, 'anna@example.com');
  assert.equal(reply.matchedBy, 'message-id');
  assert.equal(reply.isAutomatic, false);
  assert.match(reply.snippet, /drei Stellplätze frei/);
  assert.ok(!reply.snippet.includes('Gibt es noch etwas frei'), 'Zitat gehört nicht in den Auszug');
});

test('eine Abwesenheitsnotiz wird übernommen, aber gekennzeichnet', async () => {
  const parsed = await simpleParser(abwesenheit);
  const index = buildSentIndex(sentLog);
  const reply = normalizeReply(parsed, matchReplyToCampaign(parsed, index));

  assert.equal(reply.isAutomatic, true);
  assert.equal(reply.recipient, 'bernd@example.com');
  assert.match(reply.snippet, /nicht erreichbar/);
});
