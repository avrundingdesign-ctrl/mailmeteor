import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listCampaignNames,
  loadManifest,
  manifestPath,
  recipientStatus,
  safeName,
  saveManifest,
  summarize,
} from '../src/campaigns.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mailmeteor-kampagnen-'));
}

const inhalt = {
  subject: 'Kurze Frage, {{vorname}}',
  body: '<p>Hallo {{vorname}}</p>',
  isHtml: true,
  from: 'Max <max@example.com>',
  recipients: [
    { email: 'anna@example.com', fields: { vorname: 'Anna' } },
    { email: 'bernd@example.com', fields: { vorname: 'Bernd' } },
  ],
};

// --- Dateinamen ------------------------------------------------------------

test('safeName entschärft Namen für den Dateipfad', () => {
  assert.equal(safeName('Sommer Aktion 2026'), 'sommer-aktion-2026');
  assert.equal(safeName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeName('///'), 'kampagne');
});

test('Kampagnen liegen im eigenen Unterordner', () => {
  assert.equal(manifestPath('.mailmeteor', 'Sommer Aktion'), '.mailmeteor/kampagnen/sommer-aktion.json');
});

// --- Speichern und Laden ---------------------------------------------------

test('eine Kampagne wird mit Inhalt und Empfängern gespeichert', () => {
  const dir = tempDir();
  const manifest = saveManifest(dir, 'sommer', inhalt);

  assert.equal(manifest.subject, 'Kurze Frage, {{vorname}}');
  assert.equal(manifest.recipients.length, 2);
  assert.equal(manifest.recipients[0].fields.vorname, 'Anna');

  const geladen = loadManifest(dir, 'sommer');
  assert.deepEqual(geladen, manifest, 'gespeichert = geladen');
  rmSync(dir, { recursive: true, force: true });
});

test('ein zweiter Lauf behält das Anlagedatum', async () => {
  const dir = tempDir();
  const erst = saveManifest(dir, 'sommer', inhalt);
  await new Promise((r) => setTimeout(r, 5));
  const dann = saveManifest(dir, 'sommer', { ...inhalt, subject: 'Neuer Betreff' });

  assert.equal(dann.createdAt, erst.createdAt, 'angelegt bleibt angelegt');
  assert.notEqual(dann.updatedAt, erst.updatedAt);
  assert.equal(dann.subject, 'Neuer Betreff');
  rmSync(dir, { recursive: true, force: true });
});

test('vom Anhang wird nur Name und Größe archiviert, nicht der Inhalt', () => {
  const dir = tempDir();
  const manifest = saveManifest(dir, 'mit-anhang', {
    ...inhalt,
    attachments: [{ filename: 'preise.pdf', size: 4096, content: Buffer.from('geheim') }],
  });

  assert.deepEqual(manifest.attachments, [{ filename: 'preise.pdf', size: 4096 }]);
  assert.ok(!JSON.stringify(manifest).includes('geheim'));
  rmSync(dir, { recursive: true, force: true });
});

test('eine unbekannte Kampagne liefert null statt zu werfen', () => {
  const dir = tempDir();
  assert.equal(loadManifest(dir, 'gibtsnicht'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('eine beschädigte Datei macht die Liste nicht unbrauchbar', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'kampagnen'), { recursive: true });
  writeFileSync(join(dir, 'kampagnen', 'kaputt.json'), '{ohne Ende', 'utf8');

  assert.equal(loadManifest(dir, 'kaputt'), null);
  assert.deepEqual(listCampaignNames(dir), ['kaputt'], 'sie taucht trotzdem in der Liste auf');
  rmSync(dir, { recursive: true, force: true });
});

// --- Auflisten -------------------------------------------------------------

test('die Liste kennt gespeicherte Kampagnen und reine Protokolle', () => {
  const dir = tempDir();
  saveManifest(dir, 'mit-inhalt', inhalt);
  writeFileSync(join(dir, 'nur-protokoll.jsonl'), '{"status":"sent","email":"a@b.de"}\n', 'utf8');

  assert.deepEqual(listCampaignNames(dir).sort(), ['mit-inhalt', 'nur-protokoll']);
  rmSync(dir, { recursive: true, force: true });
});

test('der Antwortordner wird nicht für eine Kampagne gehalten', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'antworten'), { recursive: true });
  writeFileSync(join(dir, 'antworten', 'sommer.jsonl'), '{"type":"reply"}\n', 'utf8');
  saveManifest(dir, 'sommer', inhalt);

  assert.deepEqual(listCampaignNames(dir), ['sommer'], 'nur einmal, nicht doppelt');
  rmSync(dir, { recursive: true, force: true });
});

// --- Stand je Empfänger ----------------------------------------------------

const manifest = { recipients: inhalt.recipients };

test('jeder Empfänger bekommt seinen Stand aus dem Protokoll', () => {
  const stand = recipientStatus(manifest, [
    { status: 'sent', email: 'anna@example.com', at: '2026-07-01T10:00:00.000Z' },
  ]);

  assert.deepEqual(
    stand.map((r) => [r.email, r.status]),
    [
      ['anna@example.com', 'zugestellt'],
      ['bernd@example.com', 'offen'],
    ],
  );
});

test('ein Fehlversuch wird mit Grund ausgewiesen', () => {
  const stand = recipientStatus(manifest, [
    { status: 'failed', email: 'bernd@example.com', error: '550 unbekannt', at: '2026-07-01T10:00:00.000Z' },
  ]);

  const bernd = stand.find((r) => r.email === 'bernd@example.com');
  assert.equal(bernd.status, 'fehlgeschlagen');
  assert.equal(bernd.error, '550 unbekannt');
});

test('eine spätere Zustellung schlägt den früheren Fehlversuch', () => {
  const stand = recipientStatus(manifest, [
    { status: 'failed', email: 'anna@example.com', error: '451 später', at: '2026-07-01T10:00:00.000Z' },
    { status: 'sent', email: 'anna@example.com', at: '2026-07-01T10:05:00.000Z' },
  ]);

  const anna = stand.find((r) => r.email === 'anna@example.com');
  assert.equal(anna.status, 'zugestellt');
  assert.equal(anna.error, null);
});

test('wer nur im Protokoll steht, geht nicht verloren', () => {
  const stand = recipientStatus(manifest, [{ status: 'sent', email: 'clara@example.com', at: '2026-07-01T10:00:00.000Z' }]);
  assert.equal(stand.length, 3);
  assert.equal(stand.find((r) => r.email === 'clara@example.com').status, 'zugestellt');
});

test('recipientStatus kommt ohne gespeicherte Kampagne aus', () => {
  const stand = recipientStatus(null, [{ status: 'sent', email: 'a@b.de', at: '2026-07-01T10:00:00.000Z' }]);
  assert.deepEqual(
    stand.map((r) => r.status),
    ['zugestellt'],
  );
});

// --- Kurzfassung -----------------------------------------------------------

test('die Kurzfassung zählt zugestellt, offen und Antworten', () => {
  const kurz = summarize({
    name: 'sommer',
    manifest: { subject: 'Kurze Frage', createdAt: '2026-07-01T09:00:00.000Z', recipients: inhalt.recipients },
    logEntries: [
      { status: 'sent', email: 'anna@example.com', at: '2026-07-01T10:00:00.000Z' },
      { status: 'failed', email: 'bernd@example.com', at: '2026-07-01T10:00:05.000Z' },
    ],
    replySummary: { total: 1 },
  });

  assert.equal(kurz.subject, 'Kurze Frage');
  assert.equal(kurz.recipients, 2);
  assert.equal(kurz.sent, 1);
  assert.equal(kurz.failed, 1);
  assert.equal(kurz.open, 1, 'Bernd ist noch offen – der Fehlversuch zählt nicht als zugestellt');
  assert.equal(kurz.replies, 1);
});

test('eine Kampagne aus reinem Protokoll bleibt auswertbar', () => {
  const kurz = summarize({
    name: 'alt',
    manifest: null,
    logEntries: [{ status: 'sent', email: 'a@b.de', at: '2026-06-01T10:00:00.000Z' }],
  });

  assert.equal(kurz.hasManifest, false);
  assert.equal(kurz.recipients, 1);
  assert.equal(kurz.sent, 1);
  assert.equal(kurz.lastActivityAt, '2026-06-01T10:00:00.000Z');
});
