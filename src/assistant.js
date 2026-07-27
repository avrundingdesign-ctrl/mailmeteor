/**
 * Antworten von Claude durchsuchen lassen.
 *
 * Bewusst nur lesend: das Modell bekommt die Antworten und ein Werkzeug, um
 * eine davon vollständig nachzulesen. Es kann nichts versenden – Antworten
 * schreibt und verschickt der Anwender selbst.
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';

const MODEL = 'claude-opus-5';

/** Länge des Auszugs pro Antwort im Überblick. Der Volltext kommt per Werkzeug. */
const INDEX_EXCERPT = 700;

const SYSTEM_INSTRUCTIONS = `Du hilfst beim Durchsehen der Antworten auf eine Serienmail.

Du bekommst unten eine Übersicht aller Antworten mit Auszügen. Reicht ein Auszug
nicht aus, hol dir mit dem Werkzeug read_reply den vollständigen Text.

Regeln für deine Antwort:
- Zitiere jede Mail, auf die du dich beziehst, als [#3] – mit der Nummer aus der
  Übersicht. Die Oberfläche macht daraus einen Link zu genau dieser Mail. Ohne
  diese Markierung kann der Anwender die Mail nicht öffnen.
- Fasse dich kurz. Nenne bei einer Suche die Treffer als Liste: wer, was gesagt,
  Zitat-Nummer. Keine Wiederholung der Frage, keine Einleitung.
- Antworte auf Deutsch.
- Sag klar, wenn nichts passt, statt einen entfernt verwandten Treffer zu nennen.
  Sag ebenso klar, wenn du dir bei einer Mail unsicher bist.
- Automatische Abwesenheitsnotizen sind als solche gekennzeichnet. Zähle sie nicht
  als inhaltliche Antwort, außer es wird ausdrücklich danach gefragt.
- Du kannst keine Mails verschicken. Wird das verlangt, sag, dass der Anwender das
  im Antwortfeld neben der Mail selbst tut.`;

/** Ein Eintrag der Übersicht, die das Modell im Systemprompt sieht. */
function describeReply(reply) {
  const wer = reply.from.name ? `${reply.from.name} <${reply.from.address}>` : reply.from.address;
  const text = (reply.text ?? reply.snippet ?? '').trim();
  const gekuerzt = text.length > INDEX_EXCERPT ? `${text.slice(0, INDEX_EXCERPT).trimEnd()} […]` : text;

  return [
    `[#${reply.id}] ${reply.subject}`,
    `Von: ${wer}`,
    `Datum: ${reply.date}`,
    reply.isAutomatic ? 'Art: automatische Abwesenheitsnotiz' : null,
    reply.answered ? 'Status: bereits beantwortet' : null,
    `Text: ${gekuerzt || '(leer)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Baut den Systemprompt: feste Anweisungen zuerst, dann die Übersicht.
 *
 * Der Zwischenspeicher-Marker sitzt auf dem letzten Block, damit Folgefragen
 * im selben Chat die Übersicht nicht erneut bezahlen.
 *
 * @returns {Array<object>} System-Blöcke für die Messages-API
 */
export function buildAssistantContext(replies) {
  const uebersicht = replies.length
    ? replies.map(describeReply).join('\n\n')
    : '(Für diese Kampagne wurden noch keine Antworten abgerufen.)';

  return [
    { type: 'text', text: SYSTEM_INSTRUCTIONS },
    {
      type: 'text',
      text: `Antworten auf die Kampagne (${replies.length}):\n\n${uebersicht}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/** Die Nummern, die das Modell in seiner Antwort zitiert hat. */
export function citedIds(text) {
  return [...new Set([...String(text).matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])))];
}

/**
 * Der Volltext einer Antwort, wie ihn das Werkzeug zurückgibt.
 *
 * Eine unbekannte Nummer ist kein Fehler, sondern eine Auskunft: das Modell
 * soll sich korrigieren können, statt dass der Lauf abbricht.
 */
export function readReplyText(replies, id) {
  const reply = replies.find((r) => r.id === Number(id));
  if (!reply) return `Es gibt keine Antwort mit der Nummer ${id}.`;

  const wer = reply.from.name ? `${reply.from.name} <${reply.from.address}>` : reply.from.address;
  return [
    `[#${reply.id}] ${reply.subject}`,
    `Von: ${wer}`,
    `Datum: ${reply.date}`,
    '',
    reply.text || '(kein Text vorhanden)',
  ].join('\n');
}

/** Das Werkzeug zum Nachlesen – gebunden an genau diese Antwortliste. */
export function readReplyTool(replies) {
  return betaTool({
    name: 'read_reply',
    description:
      'Liefert den vollständigen Text einer Antwort. Nutze es, wenn der Auszug in der Übersicht nicht ausreicht, um die Frage sicher zu beantworten.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Die Nummer aus der Übersicht, z. B. 3 für [#3]' },
      },
      required: ['id'],
    },
    run: ({ id }) => readReplyText(replies, id),
  });
}

/** Prüft den Zugang, bevor eine Frage gestellt wird. */
export function loadAssistantConfig(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY fehlt in der .env. Ohne Schlüssel kann die Suche in den Antworten nicht arbeiten.',
    );
  }
  return { apiKey, baseURL: env.ANTHROPIC_BASE_URL?.trim() || undefined };
}

export function createClient(config) {
  return new Anthropic({ apiKey: config.apiKey, baseURL: config.baseURL });
}

/**
 * Stellt eine Frage zu den Antworten und meldet das Ergebnis laufend zurück.
 *
 * @param {object} options
 * @param {object} options.client Anthropic-Client (im Test ein Doppelgänger)
 * @param {Array<object>} options.replies Antworten inkl. laufender Nummer
 * @param {string} options.question Frage des Anwenders
 * @param {Array<object>} [options.history] bisheriger Chatverlauf
 * @param {(event: object) => void} [options.onEvent] Textstücke und Werkzeugaufrufe
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{text: string, cited: number[], usage: object|null}>}
 */
export async function askAboutReplies({
  client,
  replies,
  question,
  history = [],
  onEvent,
  signal,
}) {
  if (!question?.trim()) throw new Error('Ohne Frage gibt es nichts zu suchen.');

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system: buildAssistantContext(replies),
    tools: [readReplyTool(replies)],
    messages: [...history, { role: 'user', content: question }],
    stream: true,
  });

  let text = '';
  let usage = null;

  // Bei "stream: true" liefert jeder Durchlauf einen Strom, keine fertige
  // Nachricht: einmal vor dem Werkzeugaufruf, einmal für die Schlussantwort.
  for await (const stream of runner) {
    if (signal?.aborted) break;

    for await (const event of stream) {
      if (signal?.aborted) break;

      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onEvent?.({ type: 'text', text: event.delta.text });
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        onEvent?.({ type: 'tool', name: event.content_block.name });
      }
    }

    const message = await stream.finalMessage();
    usage = message.usage ?? usage;
  }

  const cited = citedIds(text);
  onEvent?.({ type: 'done', cited, usage });
  return { text, cited, usage };
}
