/**
 * CSV-Einlesen der Empfängerliste.
 *
 * Bewusst ohne Fremd-Dependency: ein kleiner RFC-4180-Parser reicht für
 * Listen, die aus Excel / Google Sheets exportiert werden (inkl. Anführungs-
 * zeichen, eingebettete Kommas und Zeilenumbrüche in Feldern).
 */

/** Zeichen, das als Spaltentrenner erkannt wird – aus der Kopfzeile geraten. */
function detectDelimiter(headerLine) {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const c of candidates) {
    const count = headerLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

/** Zerlegt CSV-Text in ein Array von Zeilen (jede Zeile ein Array von Feldern). */
export function parseCsv(text, delimiter) {
  const src = text.replace(/^﻿/, ''); // BOM aus Excel-Exporten
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = delimiter ?? detectDelimiter(firstLine);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // Teil eines CRLF – wird beim \n behandelt
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Sehr grobe Plausibilitätsprüfung – fängt Tippfehler, kein RFC-Validator. */
export function looksLikeEmail(value) {
  return /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(value);
}

/**
 * Liest CSV-Text in Empfänger-Objekte.
 *
 * Erwartet eine Spalte `email` (alternativ `e-mail`, `mail`, `adresse`).
 * Alle weiteren Spalten stehen als Platzhalter im Template zur Verfügung.
 *
 * @returns {{recipients: Array<object>, columns: string[], skipped: Array<{line: number, reason: string, raw: string}>}}
 */
export function loadRecipients(csvText, { delimiter } = {}) {
  const rows = parseCsv(csvText, delimiter);
  if (rows.length === 0) {
    throw new Error('Die Empfängerliste ist leer.');
  }

  const columns = rows[0].map((h) => h.trim());
  const emailAliases = ['email', 'e-mail', 'e_mail', 'mail', 'adresse', 'address'];
  const emailIndex = columns.findIndex((c) => emailAliases.includes(c.toLowerCase()));
  if (emailIndex === -1) {
    throw new Error(
      `Keine E-Mail-Spalte gefunden. Erwartet eine Spalte "email"; gefunden: ${columns.join(', ') || '(keine)'}`,
    );
  }

  const recipients = [];
  const skipped = [];
  const seen = new Set();

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const raw = cells.join(' | ');
    const line = r + 1; // 1-basiert, inkl. Kopfzeile

    const fields = {};
    columns.forEach((col, i) => {
      if (col) fields[col] = (cells[i] ?? '').trim();
    });

    const email = (cells[emailIndex] ?? '').trim();
    if (!email) {
      skipped.push({ line, reason: 'keine E-Mail-Adresse', raw });
      continue;
    }
    if (!looksLikeEmail(email)) {
      skipped.push({ line, reason: `ungültige Adresse "${email}"`, raw });
      continue;
    }

    const key = email.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ line, reason: `Duplikat von ${email}`, raw });
      continue;
    }
    seen.add(key);

    recipients.push({ email, line, fields });
  }

  return { recipients, columns, skipped };
}
