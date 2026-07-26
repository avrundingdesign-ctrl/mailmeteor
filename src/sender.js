/**
 * Die Versandschleife: ein Empfänger nach dem anderen.
 */

import { buildMessage } from './template.js';

/**
 * Wartet, lässt sich aber jederzeit abbrechen – sonst würde der Stop-Knopf
 * der Oberfläche erst nach der laufenden Pause reagieren.
 */
export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });

/** Wartezeit inkl. Zufallsanteil, damit der Takt nicht maschinell gleichmäßig ist. */
export function nextDelay(delayMs, jitterMs, random = Math.random) {
  if (delayMs <= 0 && jitterMs <= 0) return 0;
  return Math.max(0, Math.round(delayMs + random() * jitterMs));
}

/**
 * Unterscheidet vorübergehende von endgültigen Fehlern.
 * 4xx und Netzwerkabbrüche sind einen erneuten Versuch wert, 5xx nicht.
 */
export function isTransient(error) {
  const code = error?.responseCode ?? error?.code;
  if (typeof code === 'number') return code >= 400 && code < 500;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNECTION', 'ESOCKET', 'EAI_AGAIN', 'EDNS'].includes(code);
}

/**
 * Erkennt das Tageslimit des Anbieters. Weiterprobieren wäre hier sinnlos und
 * riskiert eine Sperre – der Lauf bricht ab und kann morgen fortgesetzt werden.
 */
export function isQuotaExceeded(error) {
  const message = `${error?.response ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return (
    message.includes('daily user sending limit') ||
    message.includes('daily sending quota') ||
    message.includes('message rate limit') ||
    message.includes('too many messages') ||
    message.includes('quota exceeded')
  );
}

/**
 * Versendet eine Nachricht mit Wiederholversuchen bei vorübergehenden Fehlern.
 */
async function sendWithRetry(transport, message, { retries, retryDelayMs, onRetry, sleepFn, signal }) {
  let attempt = 0;
  for (;;) {
    try {
      return await transport.sendMail(message);
    } catch (error) {
      if (isQuotaExceeded(error) || !isTransient(error) || attempt >= retries || signal?.aborted) {
        throw error;
      }
      attempt++;
      const wait = retryDelayMs * 2 ** (attempt - 1);
      onRetry?.({ attempt, retries, wait, error });
      await sleepFn(wait, signal);
    }
  }
}

/**
 * Arbeitet die Empfängerliste ab.
 *
 * @param {object} options
 * @param {Array<{email: string, fields: object}>} options.recipients
 * @param {{subject: string, body: string, isHtml: boolean, textBody?: string}} options.template
 * @param {object} options.envelope from / replyTo / attachments / zusätzliche Header
 * @param {object|null} options.transport `null` = Probelauf, es wird nichts versendet
 * @param {import('./log.js').SendLog} options.log
 * @param {object} options.limits delayMs, jitterMs, retries, retryDelayMs, maxPerRun
 * @param {AbortSignal} [options.signal] bricht den Lauf nach der laufenden Mail ab
 * @param {object} options.hooks Callbacks für die Ausgabe
 */
export async function sendCampaign({
  recipients,
  template,
  envelope,
  transport,
  log,
  limits,
  signal,
  hooks = {},
  sleepFn = sleep,
  random = Math.random,
}) {
  const stats = { sent: 0, failed: 0, skipped: 0, total: recipients.length };
  const dryRun = transport === null;
  let stopReason = null;

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];

    // Abbruch immer nur zwischen zwei Mails prüfen: eine bereits übergebene
    // Nachricht lässt sich nicht zurückholen.
    if (signal?.aborted) {
      stopReason = 'Vom Benutzer gestoppt';
      stats.skipped += recipients.length - i;
      break;
    }

    if (limits.maxPerRun && stats.sent >= limits.maxPerRun) {
      stopReason = `Obergrenze von ${limits.maxPerRun} Mails für diesen Lauf erreicht`;
      stats.skipped += recipients.length - i;
      break;
    }

    const { message, missing } = buildMessage(template, recipient);
    const mail = {
      ...envelope,
      ...message,
      to: recipient.email,
    };

    hooks.onBeforeSend?.({ recipient, mail, index: i, total: recipients.length, missing, dryRun });

    if (dryRun) {
      stats.sent++;
    } else {
      try {
        const info = await sendWithRetry(transport, mail, {
          retries: limits.retries,
          retryDelayMs: limits.retryDelayMs,
          onRetry: (details) => hooks.onRetry?.({ recipient, ...details }),
          sleepFn,
          signal,
        });
        log.record({ status: 'sent', email: recipient.email, messageId: info.messageId });
        stats.sent++;
        hooks.onSent?.({ recipient, info, index: i, total: recipients.length });
      } catch (error) {
        log.record({
          status: 'failed',
          email: recipient.email,
          error: error.message,
          code: error.responseCode ?? error.code ?? null,
        });
        stats.failed++;
        hooks.onFailed?.({ recipient, error, index: i, total: recipients.length });

        if (isQuotaExceeded(error)) {
          stopReason = 'Sendelimit des Anbieters erreicht – morgen mit demselben Befehl fortsetzen';
          stats.skipped += recipients.length - i - 1;
          break;
        }
      }
    }

    const isLast = i === recipients.length - 1;
    if (!isLast) {
      const wait = nextDelay(limits.delayMs, limits.jitterMs, random);
      if (wait > 0) {
        hooks.onWait?.({ wait, nextRecipient: recipients[i + 1] });
        await sleepFn(wait, signal);
      }
    }
  }

  return { ...stats, stopReason };
}
