/**
 * Speicher für die abgerufenen Antworten – dasselbe JSONL-Muster wie das
 * Versandprotokoll.
 *
 * Dadurch braucht der Chat keinen erneuten IMAP-Abruf, die Antworten
 * überstehen einen Neustart, und ein abgebrochener Abruf hinterlässt keinen
 * halben Zustand: jede Zeile ist für sich vollständig.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class ReplyStore {
  /** @param {string} path Pfad zur .jsonl-Datei */
  constructor(path) {
    this.path = path;
    this.entries = [];
    this.load();
  }

  load() {
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.entries.push(JSON.parse(trimmed));
      } catch {
        // Abgebrochener Schreibvorgang – Zeile überspringen, Rest behalten.
      }
    }
  }

  /**
   * Der sichtbare Stand: pro Message-ID der zuletzt geschriebene Eintrag.
   * Ein erneuter Abruf überschreibt damit den alten Datensatz, statt ihn zu
   * verdoppeln.
   */
  all() {
    const byMessageId = new Map();
    for (const entry of this.entries) {
      if (entry.type === 'reply') byMessageId.set(entry.messageId, entry);
    }

    const answered = new Set(
      this.entries.filter((e) => e.type === 'answered').map((e) => e.messageId),
    );

    return [...byMessageId.values()]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((entry, index) => ({
        ...entry,
        id: index + 1, // laufende Nummer für die Zitate der KI
        answered: answered.has(entry.messageId),
      }));
  }

  byId(id) {
    return this.all().find((entry) => entry.id === Number(id)) ?? null;
  }

  lastSyncAt() {
    const syncs = this.entries.filter((e) => e.type === 'sync');
    return syncs.at(-1)?.at ?? null;
  }

  /** Zählt Antworten, getrennt nach echten und automatischen. */
  summary() {
    const all = this.all();
    return {
      total: all.length,
      automatic: all.filter((entry) => entry.isAutomatic).length,
      answered: all.filter((entry) => entry.answered).length,
    };
  }

  append(row) {
    const entry = { at: new Date().toISOString(), ...row };
    this.entries.push(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  /** Schreibt eine abgerufene Antwort. Ohne Message-ID wäre kein Dedup möglich. */
  upsert(reply) {
    if (!reply.messageId) throw new Error('Antwort ohne Message-ID kann nicht gespeichert werden.');
    return this.append({ type: 'reply', ...reply });
  }

  /** Hält fest, dass auf diese Antwort geantwortet wurde. */
  markAnswered(messageId) {
    return this.append({ type: 'answered', messageId });
  }

  /** Hält einen abgeschlossenen Abruf fest, für die Anzeige „zuletzt geholt". */
  recordSync({ checked, matched }) {
    return this.append({ type: 'sync', checked, matched });
  }
}

/** Dateiname des Antwortspeichers einer Kampagne. */
export function replyStorePath(dir, campaign) {
  const safe =
    String(campaign)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 80) || 'kampagne';
  return `${dir}/antworten-${safe}.jsonl`;
}
