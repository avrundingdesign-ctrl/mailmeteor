/**
 * Versand-Protokoll als JSONL.
 *
 * Jede Zeile ist ein abgeschlossener Versuch und wird sofort auf die Platte
 * geschrieben (append + fsync-freundlich klein). Dadurch ist ein Abbruch
 * (Strg-C, Rate-Limit, Rechner aus) unkritisch: beim nächsten Start werden
 * bereits zugestellte Adressen übersprungen, niemand bekommt die Mail doppelt.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class SendLog {
  /** @param {string} path Pfad zur .jsonl-Datei */
  constructor(path) {
    this.path = path;
    this.entries = [];
    this.load();
  }

  load() {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.entries.push(JSON.parse(trimmed));
      } catch {
        // Beschädigte Zeile (z. B. abgebrochener Schreibvorgang) ignorieren –
        // im Zweifel wird die Mail erneut versendet, statt Log zu verwerfen.
      }
    }
  }

  /** Adressen, die in diesem Feldzug bereits erfolgreich zugestellt wurden. */
  sentAddresses() {
    const sent = new Set();
    for (const entry of this.entries) {
      if (entry.status === 'sent' && entry.email) sent.add(entry.email.toLowerCase());
    }
    return sent;
  }

  wasSent(email) {
    return this.sentAddresses().has(String(email).toLowerCase());
  }

  /** Zählt Ergebnisse nach Status. */
  summary() {
    const counts = { sent: 0, failed: 0 };
    for (const entry of this.entries) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return counts;
  }

  record(entry) {
    const row = { at: new Date().toISOString(), ...entry };
    this.entries.push(row);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  }
}

/** Dateiname für einen Feldzug – ohne Pfadtrenner und Sonderzeichen. */
export function campaignLogPath(dir, campaign) {
  // Punkte und Pfadtrenner fallen weg, damit kein "../" im Dateinamen landet.
  const safe = String(campaign)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80) || 'kampagne';
  return `${dir}/${safe}.jsonl`;
}
