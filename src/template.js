/**
 * Platzhalter-Ersetzung: {{spalte}} bzw. {{spalte|Standardwert}}.
 *
 * In HTML-Templates werden eingesetzte Werte HTML-escaped, damit ein
 * Nachname wie "Müller & Söhne" das Markup nicht zerlegt. In Betreff und
 * Text-Templates wird nicht escaped.
 */

const PLACEHOLDER = /\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Entfernt HTML-Kommentare.
 *
 * Zwei Gründe: interne Notizen sollen nicht im Postfach der Empfänger landen
 * (sie sind über "Original anzeigen" lesbar), und Platzhalter, die in einem
 * Kommentar nur erklärt werden, dürfen keine Warnung auslösen.
 */
export function stripHtmlComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, '');
}

/** Alle in einem Template vorkommenden Platzhalternamen. */
export function placeholderNames(template) {
  const names = new Set();
  for (const match of String(template).matchAll(PLACEHOLDER)) {
    names.add(match[1].trim());
  }
  return [...names];
}

/**
 * Setzt Platzhalter aus `fields` ein.
 *
 * Fehlt ein Wert und ist kein Standardwert angegeben, bleibt der Platzhalter
 * unersetzt und wird in `missing` gemeldet – so fällt "Hallo {{vorname}}"
 * im Dry-Run auf, statt bei echten Empfängern zu landen.
 *
 * @returns {{text: string, missing: string[]}}
 */
export function render(template, fields, { html = false } = {}) {
  const missing = [];
  const escape = html ? escapeHtml : (v) => v;

  const text = String(template).replace(PLACEHOLDER, (whole, rawName, fallback) => {
    const name = rawName.trim();
    const key = Object.keys(fields).find((k) => k.toLowerCase() === name.toLowerCase());
    const value = key === undefined ? '' : fields[key];

    if (value !== '') return escape(value);
    if (fallback !== undefined) return escape(fallback);

    missing.push(name);
    return whole;
  });

  return { text, missing };
}

/**
 * Erzeugt eine schlichte Text-Variante aus HTML, damit jede Mail einen
 * text/plain-Teil hat (hilft gegen Spam-Einstufung und für alte Clients).
 */
export function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Das \s* schluckt den Zeilenumbruch, der im Quelltext ohnehin folgt –
    // sonst entstehen doppelte Leerzeilen.
    .replace(/<br\s*\/?>\s*/gi, '\n')
    .replace(/<\/(p|h[1-6]|table|ul|ol|blockquote)>\s*/gi, '\n\n') // Absätze trennen
    .replace(/<\/(div|tr|li)>\s*/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/^[ \t]+/gm, '') // Einrückung des HTML-Quelltexts nicht übernehmen
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Optionaler Kopfblock am Anfang einer Template-Datei:
 *
 *   ---
 *   subject: Hallo {{vorname}}
 *   reply-to: team@example.com
 *   ---
 *   <p>…</p>
 *
 * So stehen Betreff und Body in einer Datei; ohne Kopfblock bleibt der Inhalt
 * unverändert und der Betreff kommt per --subject.
 *
 * @returns {{meta: object, body: string}}
 */
export function parseFrontMatter(source) {
  const text = String(source).replace(/^﻿/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    let value = line.slice(sep + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    meta[key] = value;
  }

  return { meta, body: text.slice(match[0].length) };
}

/**
 * Baut aus Template + Empfänger die konkrete Mail.
 *
 * @param {{subject: string, body: string, isHtml: boolean, textBody?: string}} tpl
 * @param {{email: string, fields: object}} recipient
 */
export function buildMessage(tpl, recipient) {
  const subject = render(tpl.subject, recipient.fields);
  const body = render(tpl.body, recipient.fields, { html: tpl.isHtml });

  const message = { to: recipient.email, subject: subject.text };
  if (tpl.isHtml) {
    message.html = body.text;
    message.text = tpl.textBody
      ? render(tpl.textBody, recipient.fields).text
      : htmlToText(body.text);
  } else {
    message.text = body.text;
  }

  return { message, missing: [...new Set([...subject.missing, ...body.missing])] };
}
