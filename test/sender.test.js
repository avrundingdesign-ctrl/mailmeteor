import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SendLog, campaignLogPath } from '../src/log.js';
import { isQuotaExceeded, isTransient, nextDelay, sendCampaign, sleep } from '../src/sender.js';

const template = { subject: 'Hallo {{vorname}}', body: 'Moin {{vorname}}', isHtml: false };
const noWait = { delayMs: 0, jitterMs: 0, retries: 0, retryDelayMs: 0, maxPerRun: 0 };

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), 'mailmeteor-test-'));
  return { log: new SendLog(join(dir, 'kampagne.jsonl')), dir };
}

function fakeTransport(behaviour = () => ({ messageId: 'ok' })) {
  const sent = [];
  return {
    sent,
    async sendMail(mail) {
      sent.push(mail);
      return behaviour(mail, sent.length);
    },
  };
}

function recipientsFor(...emails) {
  return emails.map((email, i) => ({ email, line: i + 2, fields: { email, vorname: `Nr${i}` } }));
}

test('jeder Empfänger bekommt eine eigene Mail, ohne cc/bcc', async () => {
  const { log, dir } = tempLog();
  const transport = fakeTransport();

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de', 'c@d.de'),
    template,
    envelope: { from: 'ich@example.com' },
    transport,
    log,
    limits: noWait,
    sleepFn: async () => {},
  });

  assert.equal(result.sent, 2);
  assert.deepEqual(
    transport.sent.map((m) => m.to),
    ['a@b.de', 'c@d.de'],
  );
  for (const mail of transport.sent) {
    assert.equal(mail.cc, undefined);
    assert.equal(mail.bcc, undefined);
    assert.equal(typeof mail.to, 'string');
  }
  assert.equal(transport.sent[0].subject, 'Hallo Nr0');
  rmSync(dir, { recursive: true, force: true });
});

test('Probelauf (transport = null) versendet nichts und protokolliert nichts', async () => {
  const { log, dir } = tempLog();

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de'),
    template,
    envelope: {},
    transport: null,
    log,
    limits: noWait,
    sleepFn: async () => {},
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(log.entries, []);
  rmSync(dir, { recursive: true, force: true });
});

test('erfolgreiche Zustellungen landen im Protokoll und werden nicht wiederholt', async () => {
  const { log, dir } = tempLog();

  await sendCampaign({
    recipients: recipientsFor('a@b.de'),
    template,
    envelope: {},
    transport: fakeTransport(),
    log,
    limits: noWait,
    sleepFn: async () => {},
  });

  assert.ok(log.wasSent('A@B.de'), 'Abgleich muss unabhängig von Groß-/Kleinschreibung sein');

  const wiedergeladen = new SendLog(log.path);
  assert.ok(wiedergeladen.wasSent('a@b.de'), 'Protokoll muss einen Neustart überleben');
  assert.deepEqual(wiedergeladen.summary(), { sent: 1, failed: 0 });
  rmSync(dir, { recursive: true, force: true });
});

test('ein einzelner Fehler stoppt den Lauf nicht', async () => {
  const { log, dir } = tempLog();
  const transport = fakeTransport((mail) => {
    if (mail.to === 'b@b.de') {
      const error = new Error('550 Adresse existiert nicht');
      error.responseCode = 550;
      throw error;
    }
    return { messageId: 'ok' };
  });

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de', 'b@b.de', 'c@b.de'),
    template,
    envelope: {},
    transport,
    log,
    limits: noWait,
    sleepFn: async () => {},
  });

  assert.deepEqual({ sent: result.sent, failed: result.failed }, { sent: 2, failed: 1 });
  assert.equal(log.wasSent('b@b.de'), false, 'Fehlversuch darf nicht als zugestellt gelten');
  rmSync(dir, { recursive: true, force: true });
});

test('vorübergehende Fehler werden wiederholt, endgültige nicht', async () => {
  const { log, dir } = tempLog();
  let versuche = 0;
  const transport = fakeTransport(() => {
    versuche++;
    if (versuche < 3) {
      const error = new Error('451 später nochmal');
      error.responseCode = 451;
      throw error;
    }
    return { messageId: 'ok' };
  });

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de'),
    template,
    envelope: {},
    transport,
    log,
    limits: { ...noWait, retries: 3 },
    sleepFn: async () => {},
  });

  assert.equal(result.sent, 1);
  assert.equal(versuche, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('bei erreichtem Tageslimit bricht der Lauf ab statt weiterzuprobieren', async () => {
  const { log, dir } = tempLog();
  const transport = fakeTransport(() => {
    const error = new Error('Daily user sending limit exceeded');
    error.responseCode = 550;
    throw error;
  });

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de', 'c@d.de', 'e@f.de'),
    template,
    envelope: {},
    transport,
    log,
    limits: noWait,
    sleepFn: async () => {},
  });

  assert.equal(transport.sent.length, 1, 'nach dem Limit darf nichts mehr rausgehen');
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 2);
  assert.match(result.stopReason, /Sendelimit/);
  rmSync(dir, { recursive: true, force: true });
});

test('--max begrenzt den einzelnen Lauf', async () => {
  const { log, dir } = tempLog();
  const transport = fakeTransport();

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de', 'c@d.de', 'e@f.de'),
    template,
    envelope: {},
    transport,
    log,
    limits: { ...noWait, maxPerRun: 2 },
    sleepFn: async () => {},
  });

  assert.equal(transport.sent.length, 2);
  assert.equal(result.skipped, 1);
  assert.match(result.stopReason, /Obergrenze/);
  rmSync(dir, { recursive: true, force: true });
});

test('zwischen den Mails wird gewartet, nach der letzten nicht', async () => {
  const { log, dir } = tempLog();
  const pausen = [];

  await sendCampaign({
    recipients: recipientsFor('a@b.de', 'c@d.de', 'e@f.de'),
    template,
    envelope: {},
    transport: fakeTransport(),
    log,
    limits: { ...noWait, delayMs: 3000, jitterMs: 2000 },
    sleepFn: async (ms) => pausen.push(ms),
    random: () => 0.5,
  });

  assert.deepEqual(pausen, [4000, 4000]);
  rmSync(dir, { recursive: true, force: true });
});

test('nextDelay bleibt im erwarteten Bereich', () => {
  assert.equal(nextDelay(1000, 500, () => 0), 1000);
  assert.equal(nextDelay(1000, 500, () => 1), 1500);
  assert.equal(nextDelay(0, 0), 0);
});

test('isTransient stuft Fehlerklassen richtig ein', () => {
  assert.ok(isTransient({ responseCode: 421 }));
  assert.ok(isTransient({ code: 'ETIMEDOUT' }));
  assert.ok(!isTransient({ responseCode: 550 }));
  assert.ok(!isTransient({ code: 'EAUTH' }));
});

test('isQuotaExceeded erkennt die üblichen Limit-Meldungen', () => {
  assert.ok(isQuotaExceeded({ response: '550 5.4.5 Daily user sending limit exceeded' }));
  assert.ok(isQuotaExceeded({ message: 'Too many messages per connection' }));
  assert.ok(!isQuotaExceeded({ message: 'Mailbox not found' }));
});

test('campaignLogPath erzeugt sichere Dateinamen', () => {
  assert.equal(campaignLogPath('.mailmeteor', 'Sommer Aktion 2026'), '.mailmeteor/sommer-aktion-2026.jsonl');
  assert.equal(campaignLogPath('.mailmeteor', '../../etc/passwd'), '.mailmeteor/etc-passwd.jsonl');
  assert.equal(campaignLogPath('.mailmeteor', '///'), '.mailmeteor/kampagne.jsonl');
});

test('beschädigte Protokollzeilen machen das Protokoll nicht unbrauchbar', () => {
  const { log, dir } = tempLog();
  log.record({ status: 'sent', email: 'a@b.de' });
  appendFileSync(log.path, '{kaputt\n');
  log.record({ status: 'sent', email: 'c@d.de' });

  const neu = new SendLog(log.path);
  assert.deepEqual(neu.sentAddresses(), new Set(['a@b.de', 'c@d.de']));
  rmSync(dir, { recursive: true, force: true });
});

test('ein Abbruch stoppt vor der nächsten Mail, nicht mitten in einer', async () => {
  const { log, dir } = tempLog();
  const controller = new AbortController();
  const transport = fakeTransport((mail, count) => {
    if (count === 2) controller.abort(); // während der zweiten Zustellung
    return { messageId: 'ok' };
  });

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de', 'c@d.de', 'e@f.de', 'g@h.de'),
    template,
    envelope: {},
    transport,
    log,
    limits: noWait,
    signal: controller.signal,
    sleepFn: async () => {},
  });

  assert.equal(transport.sent.length, 2, 'die laufende Mail wird noch fertig zugestellt');
  assert.equal(result.sent, 2);
  assert.equal(result.skipped, 2);
  assert.match(result.stopReason, /gestoppt/i);
  assert.equal(new SendLog(log.path).summary().sent, 2, 'das Protokoll kennt die zwei Zustellungen');
  rmSync(dir, { recursive: true, force: true });
});

test('ein bereits abgebrochener Lauf sendet gar nichts', async () => {
  const { log, dir } = tempLog();
  const transport = fakeTransport();

  const result = await sendCampaign({
    recipients: recipientsFor('a@b.de', 'c@d.de'),
    template,
    envelope: {},
    transport,
    log,
    limits: noWait,
    signal: AbortSignal.abort(),
    sleepFn: async () => {},
  });

  assert.equal(transport.sent.length, 0);
  assert.equal(result.skipped, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('sleep bricht sofort ab, wenn das Signal ausgelöst wird', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = sleep(60_000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - started < 1000, 'die Pause darf den Stop nicht blockieren');
});
