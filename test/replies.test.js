import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReplyStore, replyStorePath } from '../src/replies.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mailmeteor-antworten-'));
  return { store: new ReplyStore(join(dir, 'antworten.jsonl')), dir };
}

function reply(overrides = {}) {
  return {
    messageId: 'a@example.com',
    from: { name: 'Anna', address: 'anna@example.com' },
    recipient: 'anna@example.com',
    matchedBy: 'message-id',
    subject: 'Re: Kurze Frage',
    date: '2026-07-02T09:15:00.000Z',
    text: 'Ja, wir haben frei.',
    snippet: 'Ja, wir haben frei.',
    isAutomatic: false,
    ...overrides,
  };
}

test('Antworten bekommen eine laufende Nummer nach Datum', () => {
  const { store, dir } = tempStore();
  store.upsert(reply({ messageId: 'zweite@x', date: '2026-07-03T00:00:00.000Z' }));
  store.upsert(reply({ messageId: 'erste@x', date: '2026-07-01T00:00:00.000Z' }));

  assert.deepEqual(
    store.all().map((r) => [r.id, r.messageId]),
    [
      [1, 'erste@x'],
      [2, 'zweite@x'],
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});

test('ein zweiter Abruf verdoppelt nichts, sondern aktualisiert', () => {
  const { store, dir } = tempStore();
  store.upsert(reply({ subject: 'Erst so' }));
  store.upsert(reply({ subject: 'Dann so' }));

  const all = store.all();
  assert.equal(all.length, 1, 'gleiche Message-ID bleibt ein Eintrag');
  assert.equal(all[0].subject, 'Dann so', 'der neuere Stand gewinnt');
  rmSync(dir, { recursive: true, force: true });
});

test('der Speicher übersteht einen Neustart', () => {
  const { store, dir } = tempStore();
  store.upsert(reply());
  store.recordSync({ checked: 40, matched: 1 });

  const wiedergeladen = new ReplyStore(store.path);
  assert.equal(wiedergeladen.all().length, 1);
  assert.ok(wiedergeladen.lastSyncAt(), 'Zeitpunkt des Abrufs überlebt');
  rmSync(dir, { recursive: true, force: true });
});

test('beantwortete Mails werden markiert', () => {
  const { store, dir } = tempStore();
  store.upsert(reply());
  assert.equal(store.all()[0].answered, false);

  store.markAnswered('a@example.com');
  assert.equal(store.all()[0].answered, true);
  assert.equal(store.summary().answered, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('summary trennt echte von automatischen Antworten', () => {
  const { store, dir } = tempStore();
  store.upsert(reply({ messageId: 'a@x' }));
  store.upsert(reply({ messageId: 'b@x', isAutomatic: true }));

  assert.deepEqual(store.summary(), { total: 2, automatic: 1, answered: 0 });
  rmSync(dir, { recursive: true, force: true });
});

test('byId liefert genau die zitierte Antwort', () => {
  const { store, dir } = tempStore();
  store.upsert(reply({ messageId: 'a@x', date: '2026-07-01T00:00:00.000Z' }));
  store.upsert(reply({ messageId: 'b@x', date: '2026-07-02T00:00:00.000Z', subject: 'Zweite' }));

  assert.equal(store.byId(2).subject, 'Zweite');
  assert.equal(store.byId(99), null);
  rmSync(dir, { recursive: true, force: true });
});

test('eine beschädigte Zeile macht den Speicher nicht unbrauchbar', () => {
  const { store, dir } = tempStore();
  store.upsert(reply({ messageId: 'a@x' }));
  appendFileSync(store.path, '{kaputt\n');
  store.upsert(reply({ messageId: 'b@x' }));

  assert.equal(new ReplyStore(store.path).all().length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('eine Antwort ohne Message-ID wird abgelehnt', () => {
  const { store, dir } = tempStore();
  assert.throws(() => store.upsert(reply({ messageId: '' })), /Message-ID/);
  rmSync(dir, { recursive: true, force: true });
});

test('replyStorePath erzeugt sichere Dateinamen', () => {
  assert.equal(replyStorePath('.mailmeteor', 'Sommer Aktion'), '.mailmeteor/antworten-sommer-aktion.jsonl');
  assert.equal(replyStorePath('.mailmeteor', '../../etc/passwd'), '.mailmeteor/antworten-etc-passwd.jsonl');
});
