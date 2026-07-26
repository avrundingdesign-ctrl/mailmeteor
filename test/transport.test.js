import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSmtpConfig } from '../src/transport.js';

test('Gmail-Adressen erhalten Host und Port automatisch', () => {
  const config = loadSmtpConfig({ SMTP_USER: 'a@gmail.com', SMTP_PASS: 'x' });
  assert.equal(config.host, 'smtp.gmail.com');
  assert.equal(config.port, 465);
  assert.equal(config.secure, true);
  assert.equal(config.from, 'a@gmail.com', 'ohne MAIL_FROM gilt der SMTP-Benutzer');
});

test('eigene Angaben schlagen die Voreinstellung des Anbieters', () => {
  const config = loadSmtpConfig({
    SMTP_USER: 'a@gmail.com',
    SMTP_PASS: 'x',
    SMTP_HOST: 'mail.eigene-domain.de',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    MAIL_FROM: 'Max <max@eigene-domain.de>',
    MAIL_REPLY_TO: 'antwort@eigene-domain.de',
  });

  assert.equal(config.host, 'mail.eigene-domain.de');
  assert.equal(config.port, 587);
  assert.equal(config.secure, false);
  assert.equal(config.from, 'Max <max@eigene-domain.de>');
  assert.equal(config.replyTo, 'antwort@eigene-domain.de');
});

test('secure wird aus dem Port abgeleitet, wenn nichts angegeben ist', () => {
  const base = { SMTP_USER: 'a@eigene.de', SMTP_PASS: 'x', SMTP_HOST: 'mail.eigene.de' };
  assert.equal(loadSmtpConfig({ ...base, SMTP_PORT: '465' }).secure, true);
  assert.equal(loadSmtpConfig({ ...base, SMTP_PORT: '587' }).secure, false);
});

test('fehlende Zugangsdaten werden gesammelt gemeldet', () => {
  assert.throws(() => loadSmtpConfig({}), /SMTP_USER, SMTP_PASS/);
  assert.throws(
    () => loadSmtpConfig({ SMTP_USER: 'a@unbekannter-anbieter.de', SMTP_PASS: 'x' }),
    /SMTP_HOST/,
  );
});
