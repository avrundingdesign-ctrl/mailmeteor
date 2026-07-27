/**
 * Kampagnen als benannte, wiederauffindbare Sache.
 *
 * Das Versandprotokoll hält bisher nur fest, wer die Mail bekommen hat – nicht
 * aber, *was* verschickt wurde und an wen es gehen sollte. Ohne das lässt sich
 * eine Kampagne später weder ansehen noch fortsetzen, und die Frage an die KI
 * hat keinen Bezug.
 *
 * Ablage getrennt nach Zweck, damit sich die Dateien nicht in die Quere kommen:
 *   .mailmeteor/<name>.jsonl              Versandprotokoll (unverändert)
 *   .mailmeteor/kampagnen/<name>.json     was verschickt wurde
 *   .mailmeteor/antworten/<name>.jsonl    was zurückkam
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Dateiname ohne Pfadtrenner und Sonderzeichen. */
export function safeName(campaign) {
  return (
    String(campaign)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 80) || 'kampagne'
  );
}

export function manifestPath(dir, campaign) {
  return join(dir, 'kampagnen', `${safeName(campaign)}.json`);
}

/**
 * Schreibt fest, was diese Kampagne ist. Beim zweiten Lauf derselben Kampagne
 * bleibt das Anlagedatum stehen – nur der Inhalt wird aktualisiert.
 */
export function saveManifest(dir, campaign, data) {
  const path = manifestPath(dir, campaign);
  const bestehend = loadManifest(dir, campaign);

  const manifest = {
    name: campaign,
    createdAt: bestehend?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subject: data.subject ?? '',
    body: data.body ?? '',
    isHtml: data.isHtml !== false,
    from: data.from ?? '',
    replyTo: data.replyTo || null,
    // Nur Name und Größe der Anhänge – der Inhalt gehört nicht ins Archiv.
    attachments: (data.attachments ?? []).map((a) => ({ filename: a.filename, size: a.size ?? 0 })),
    recipients: (data.recipients ?? []).map((r) => ({ email: r.email, fields: r.fields ?? {} })),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function loadManifest(dir, campaign) {
  const path = manifestPath(dir, campaign);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Beschädigte Datei soll die Liste nicht unbrauchbar machen.
    return null;
  }
}

/**
 * Alle bekannten Kampagnen – auch die, für die es nur ein Protokoll gibt
 * (etwa aus einem Lauf über die Kommandozeile).
 *
 * @returns {string[]} Namen, wie sie für die Dateipfade gelten
 */
export function listCampaignNames(dir) {
  const namen = new Set();

  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.jsonl')) namen.add(file.replace(/\.jsonl$/, ''));
    }
  }

  const manifestDir = join(dir, 'kampagnen');
  if (existsSync(manifestDir)) {
    for (const file of readdirSync(manifestDir)) {
      if (file.endsWith('.json')) namen.add(file.replace(/\.json$/, ''));
    }
  }

  return [...namen];
}

/**
 * Verbindet Empfängerliste und Protokoll zum Stand je Empfänger.
 *
 * Wer im Protokoll steht, aber nicht mehr in der Liste (Liste nachträglich
 * geändert), taucht trotzdem auf – verschickt wurde ja an ihn.
 */
export function recipientStatus(manifest, logEntries) {
  const stand = new Map();

  for (const recipient of manifest?.recipients ?? []) {
    stand.set(recipient.email.toLowerCase(), {
      email: recipient.email,
      fields: recipient.fields ?? {},
      status: 'offen',
      at: null,
      error: null,
    });
  }

  for (const entry of logEntries) {
    if (!entry.email) continue;
    const key = entry.email.toLowerCase();
    const vorhanden = stand.get(key) ?? { email: entry.email, fields: {}, status: 'offen', at: null, error: null };

    // Eine spätere Zustellung schlägt einen früheren Fehlversuch.
    if (entry.status === 'sent') {
      stand.set(key, { ...vorhanden, status: 'zugestellt', at: entry.at, error: null });
    } else if (entry.status === 'failed' && vorhanden.status !== 'zugestellt') {
      stand.set(key, { ...vorhanden, status: 'fehlgeschlagen', at: entry.at, error: entry.error ?? null });
    }
  }

  return [...stand.values()];
}

/** Kurzfassung einer Kampagne für die Übersichtsliste. */
export function summarize({ name, manifest, logEntries, replySummary }) {
  const zugestellt = logEntries.filter((e) => e.status === 'sent').length;
  const fehlgeschlagen = logEntries.filter((e) => e.status === 'failed').length;
  const geplant = manifest?.recipients?.length ?? 0;
  const letzterEintrag = logEntries.at(-1)?.at ?? null;

  return {
    name,
    subject: manifest?.subject ?? '',
    createdAt: manifest?.createdAt ?? letzterEintrag,
    lastActivityAt: letzterEintrag ?? manifest?.updatedAt ?? null,
    recipients: Math.max(geplant, zugestellt + fehlgeschlagen),
    sent: zugestellt,
    failed: fehlgeschlagen,
    open: Math.max(0, geplant - zugestellt),
    replies: replySummary?.total ?? 0,
    hasManifest: Boolean(manifest),
  };
}
