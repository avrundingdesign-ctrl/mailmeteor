import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMessage,
  escapeHtml,
  htmlToText,
  parseFrontMatter,
  placeholderNames,
  render,
  stripHtmlComments,
} from '../src/template.js';

test('render setzt Platzhalter ein, unabhängig von Groß-/Kleinschreibung', () => {
  const { text, missing } = render('Hallo {{Vorname}}!', { vorname: 'Anna' });
  assert.equal(text, 'Hallo Anna!');
  assert.deepEqual(missing, []);
});

test('render nutzt den Standardwert nach dem Pipe-Zeichen', () => {
  assert.equal(render('Hallo {{vorname|zusammen}}', {}).text, 'Hallo zusammen');
  assert.equal(render('Hallo {{vorname|zusammen}}', { vorname: '' }).text, 'Hallo zusammen');
});

test('render lässt fehlende Platzhalter stehen und meldet sie', () => {
  const { text, missing } = render('Hallo {{vorname}}', { firma: 'ACME' });
  assert.equal(text, 'Hallo {{vorname}}');
  assert.deepEqual(missing, ['vorname']);
});

test('render escaped Werte nur im HTML-Modus', () => {
  const fields = { firma: 'Muster & Söhne <KG>' };
  assert.equal(render('{{firma}}', fields, { html: true }).text, 'Muster &amp; Söhne &lt;KG&gt;');
  assert.equal(render('{{firma}}', fields).text, 'Muster & Söhne <KG>');
});

test('escapeHtml deckt alle kritischen Zeichen ab', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('placeholderNames listet jeden Namen einmal', () => {
  assert.deepEqual(placeholderNames('{{a}} {{ b |x}} {{a}}'), ['a', 'b']);
});

test('parseFrontMatter trennt Kopfblock und Inhalt', () => {
  const { meta, body } = parseFrontMatter('---\nsubject: Hallo {{vorname}}\nreply-to: a@b.de\n---\n<p>Text</p>\n');
  assert.equal(meta.subject, 'Hallo {{vorname}}');
  assert.equal(meta['reply-to'], 'a@b.de');
  assert.equal(body, '<p>Text</p>\n');
});

test('parseFrontMatter lässt Dateien ohne Kopfblock unverändert', () => {
  const source = '<p>Nur Inhalt</p>';
  assert.deepEqual(parseFrontMatter(source), { meta: {}, body: source });
});

test('parseFrontMatter behandelt einen Doppelpunkt im Betreff korrekt', () => {
  const { meta } = parseFrontMatter('---\nsubject: Angebot: 20% Rabatt\n---\nText');
  assert.equal(meta.subject, 'Angebot: 20% Rabatt');
});

test('stripHtmlComments entfernt Notizen samt Platzhaltern darin', () => {
  const cleaned = stripHtmlComments('<!-- nutze {{spalte}} -->\n<p>Hallo</p>');
  assert.equal(cleaned.trim(), '<p>Hallo</p>');
  assert.deepEqual(placeholderNames(cleaned), []);
});

test('htmlToText macht aus <br> genau einen Umbruch', () => {
  const text = htmlToText('<p>Viele Grüße<br />\n    Max Mustermann</p>');
  assert.equal(text, 'Viele Grüße\nMax Mustermann');
});

test('htmlToText formt Listen als Aufzählung', () => {
  const text = htmlToText('<ul><li>eins</li><li>zwei</li></ul>');
  assert.equal(text, '- eins\n- zwei');
});

test('htmlToText übernimmt die Einrückung des Quelltexts nicht', () => {
  const text = htmlToText('<div>\n  <p>Hallo Anna,</p>\n  <p>bis bald.</p>\n</div>');
  assert.equal(text, 'Hallo Anna,\n\nbis bald.');
});

test('htmlToText erzeugt eine lesbare Textfassung', () => {
  const text = htmlToText('<p>Hallo Anna,</p><p>schau <a href="https://x.de">hier</a>.</p>');
  assert.equal(text, 'Hallo Anna,\n\nschau hier (https://x.de).');
});

test('buildMessage erzeugt HTML plus automatische Textfassung', () => {
  const { message, missing } = buildMessage(
    { subject: 'Hallo {{vorname}}', body: '<p>Moin {{vorname}}</p>', isHtml: true },
    { email: 'a@b.de', fields: { vorname: 'Anna' } },
  );

  assert.equal(message.to, 'a@b.de');
  assert.equal(message.subject, 'Hallo Anna');
  assert.equal(message.html, '<p>Moin Anna</p>');
  assert.equal(message.text, 'Moin Anna');
  assert.deepEqual(missing, []);
});

test('buildMessage sendet Text-Templates ohne HTML-Teil', () => {
  const { message } = buildMessage(
    { subject: 'Test', body: 'Moin {{vorname}}', isHtml: false },
    { email: 'a@b.de', fields: { vorname: 'Anna' } },
  );
  assert.equal(message.text, 'Moin Anna');
  assert.equal(message.html, undefined);
});

test('buildMessage sammelt fehlende Platzhalter aus Betreff und Body', () => {
  const { missing } = buildMessage(
    { subject: '{{firma}}', body: 'Hallo {{vorname}}', isHtml: false },
    { email: 'a@b.de', fields: {} },
  );
  assert.deepEqual(missing.sort(), ['firma', 'vorname']);
});
