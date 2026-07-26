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

/** Aus "Anna Maria Müller" wird {{name}} und {{vorname}}. */
function namesFrom(displayName, email) {
  const name = displayName.trim().replace(/^["']|["']$/g, '').trim();
  if (name) {
    // "Müller, Anna" (Outlook-Schreibweise) zu "Anna Müller" drehen
    const swapped = /^([^,]+),\s*(.+)$/.exec(name);
    const full = swapped ? `${swapped[2].trim()} ${swapped[1].trim()}` : name;
    return { name: full, vorname: full.split(/\s+/)[0] };
  }

  // Ohne Anzeigename aus dem lokalen Teil raten: "anna.mueller@…" → "Anna"
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
  const first = local.split(/\s+/)[0] ?? '';
  const capitalised = first ? first[0].toUpperCase() + first.slice(1) : '';
  return { name: capitalised, vorname: capitalised };
}

/**
 * Liest eine frei eingefügte Adressliste – der übliche Weg beim Kopieren aus
 * einem Mailprogramm, einer Tabelle oder einer Notiz.
 *
 * Erkannt werden: eine Adresse pro Zeile, durch Komma/Semikolon getrennt,
 * `Anna Müller <anna@example.com>`, `"Müller, Anna" <anna@example.com>`,
 * `mailto:`-Links sowie beliebige Kombinationen davon.
 *
 * @returns {{recipients: Array<object>, columns: string[], skipped: Array<{line: number, reason: string, raw: string}>}}
 */
export function parseAddressList(text) {
  const recipients = [];
  const skipped = [];
  const seen = new Set();

  const chunks = String(text)
    .replace(/^﻿/, '')
    // Trennzeichen vereinheitlichen, aber nur außerhalb von <…> und "…"
    .split(/\r?\n/)
    .flatMap((line, lineIndex) => {
      const parts = [];
      let current = '';
      let inAngle = false;
      let inQuotes = false;

      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === '<') inAngle = true;
        else if (ch === '>') inAngle = false;

        if ((ch === ',' || ch === ';') && !inAngle && !inQuotes) {
          parts.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      parts.push(current);

      return parts.map((raw) => ({ raw, line: lineIndex + 1 }));
    })
    .filter(({ raw }) => raw.trim() !== '');

  for (const { raw, line } of chunks) {
    const entry = raw.trim().replace(/^mailto:/i, '');

    // "Anna Müller <anna@example.com>" oder nur "anna@example.com"
    const angle = /^(.*?)<\s*([^>]+?)\s*>$/.exec(entry);
    const email = (angle ? angle[2] : entry).trim().replace(/^mailto:/i, '');
    const displayName = angle ? angle[1] : '';

    if (!looksLikeEmail(email)) {
      skipped.push({ line, reason: `keine gültige Adresse: "${entry}"`, raw: entry });
      continue;
    }

    const key = email.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ line, reason: `Duplikat von ${email}`, raw: entry });
      continue;
    }
    seen.add(key);

    const { name, vorname } = namesFrom(displayName, email);
    recipients.push({ email, line, fields: { email, name, vorname } });
  }

  return { recipients, columns: ['email', 'name', 'vorname'], skipped };
}

/** Erkennt, ob ein Text eine CSV mit Kopfzeile ist oder eine lose Adressliste. */
export function looksLikeCsv(text) {
  const firstLine = String(text).replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  if (looksLikeEmail(firstLine.trim())) return false; // Kopfzeile wäre keine Adresse
  const aliases = ['email', 'e-mail', 'e_mail', 'mail', 'adresse', 'address'];
  return firstLine
    .split(/[,;\t]/)
    .some((cell) => aliases.includes(cell.trim().toLowerCase().replace(/^["']|["']$/g, '')));
}

/**
 * Nimmt beides entgegen: eingefügte Adressen oder eine CSV mit Kopfzeile.
 * Die Unterscheidung passiert automatisch anhand der ersten Zeile.
 */
export function loadAnyRecipients(text, { delimiter } = {}) {
  return looksLikeCsv(text)
    ? { ...loadRecipients(text, { delimiter }), format: 'csv' }
    : { ...parseAddressList(text), format: 'list' };
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
