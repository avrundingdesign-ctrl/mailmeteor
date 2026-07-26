import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadRecipients, looksLikeEmail, parseCsv } from '../src/recipients.js';

test('parseCsv liest Anführungszeichen, Kommas und Zeilenumbrüche in Feldern', () => {
  const rows = parseCsv('a,b\n"Muster, KG","Zeile1\nZeile2"\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['Muster, KG', 'Zeile1\nZeile2'],
  ]);
});

test('parseCsv versteht doppelte Anführungszeichen als Escape', () => {
  const rows = parseCsv('a\n"sagt ""hallo"""\n');
  assert.deepEqual(rows[1], ['sagt "hallo"']);
});

test('parseCsv erkennt Semikolon als Trenner (deutsches Excel)', () => {
  const rows = parseCsv('email;vorname\na@b.de;Anna\n');
  assert.deepEqual(rows, [
    ['email', 'vorname'],
    ['a@b.de', 'Anna'],
  ]);
});

test('parseCsv verkraftet BOM und CRLF', () => {
  const rows = parseCsv('﻿email,vorname\r\na@b.de,Anna\r\n');
  assert.deepEqual(rows[0], ['email', 'vorname']);
  assert.deepEqual(rows[1], ['a@b.de', 'Anna']);
});

test('looksLikeEmail trennt brauchbare von unbrauchbaren Adressen', () => {
  assert.ok(looksLikeEmail('a.b+tag@example.co.uk'));
  assert.ok(!looksLikeEmail('kein-at-zeichen.de'));
  assert.ok(!looksLikeEmail('a@localhost'));
  assert.ok(!looksLikeEmail('a@b.de, c@d.de'));
  assert.ok(!looksLikeEmail('mit leer@example.com'));
});

test('loadRecipients stellt alle Spalten als Felder bereit', () => {
  const { recipients, columns } = loadRecipients('email,vorname,firma\na@b.de,Anna,ACME\n');
  assert.deepEqual(columns, ['email', 'vorname', 'firma']);
  assert.equal(recipients.length, 1);
  assert.deepEqual(recipients[0].fields, { email: 'a@b.de', vorname: 'Anna', firma: 'ACME' });
});

test('loadRecipients überspringt Duplikate, leere und ungültige Adressen', () => {
  const csv = ['email,vorname', 'a@b.de,Anna', 'A@B.de,Anna nochmal', ',Ohne', 'kaputt,Fehler'].join(
    '\n',
  );
  const { recipients, skipped } = loadRecipients(csv);

  assert.deepEqual(
    recipients.map((r) => r.email),
    ['a@b.de'],
  );
  assert.equal(skipped.length, 3);
  assert.match(skipped[0].reason, /Duplikat/);
  assert.match(skipped[1].reason, /keine E-Mail/);
  assert.match(skipped[2].reason, /ungültig/);
});

test('loadRecipients akzeptiert alternative Spaltennamen', () => {
  const { recipients } = loadRecipients('Name;E-Mail\nAnna;a@b.de\n');
  assert.equal(recipients[0].email, 'a@b.de');
  assert.equal(recipients[0].fields.Name, 'Anna');
});

test('loadRecipients meldet fehlende E-Mail-Spalte verständlich', () => {
  assert.throws(() => loadRecipients('name,firma\nAnna,ACME\n'), /Keine E-Mail-Spalte/);
});

test('loadRecipients meldet leere Datei', () => {
  assert.throws(() => loadRecipients(''), /leer/);
});

test('loadRecipients merkt sich die Zeilennummer für Fehlermeldungen', () => {
  const { recipients } = loadRecipients('email\na@b.de\nc@d.de\n');
  assert.deepEqual(
    recipients.map((r) => r.line),
    [2, 3],
  );
});
