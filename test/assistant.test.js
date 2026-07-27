import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  askAboutReplies,
  buildAssistantContext,
  citedIds,
  loadAssistantConfig,
  readReplyText,
  readReplyTool,
} from '../src/assistant.js';

const replies = [
  {
    id: 1,
    from: { name: 'Anna Müller', address: 'anna@example.com' },
    subject: 'Re: Kurze Frage',
    date: '2026-07-02T09:15:00.000Z',
    text: 'Ja, wir haben noch drei Stellplätze frei.',
    isAutomatic: false,
    answered: false,
  },
  {
    id: 2,
    from: { name: '', address: 'bernd@example.com' },
    subject: 'Automatische Antwort',
    date: '2026-07-02T09:20:00.000Z',
    text: 'Bin bis 15.08. nicht da.',
    isAutomatic: true,
    answered: false,
  },
];

// --- Systemprompt ----------------------------------------------------------

test('die Übersicht enthält jede Antwort mit ihrer Zitatnummer', () => {
  const blocks = buildAssistantContext(replies);
  const uebersicht = blocks.at(-1).text;

  assert.match(uebersicht, /\[#1\] Re: Kurze Frage/);
  assert.match(uebersicht, /Anna Müller <anna@example\.com>/);
  assert.match(uebersicht, /drei Stellplätze frei/);
  assert.match(uebersicht, /\[#2\]/);
  assert.match(uebersicht, /automatische Abwesenheitsnotiz/, 'Automaten sind gekennzeichnet');
});

test('nur der letzte Block trägt den Zwischenspeicher-Marker', () => {
  const blocks = buildAssistantContext(replies);
  assert.equal(blocks[0].cache_control, undefined);
  assert.deepEqual(blocks.at(-1).cache_control, { type: 'ephemeral' });
});

test('lange Antworten werden für die Übersicht gekürzt', () => {
  const blocks = buildAssistantContext([{ ...replies[0], text: 'y'.repeat(3000) }]);
  const uebersicht = blocks.at(-1).text;
  assert.ok(uebersicht.length < 2000, 'die Übersicht bleibt kompakt');
  assert.match(uebersicht, /\[…\]/, 'die Kürzung ist sichtbar');
});

test('ohne Antworten sagt die Übersicht das ausdrücklich', () => {
  assert.match(buildAssistantContext([]).at(-1).text, /noch keine Antworten/);
});

// --- Zitate ----------------------------------------------------------------

test('citedIds sammelt jede Nummer einmal, in Reihenfolge des Auftretens', () => {
  assert.deepEqual(citedIds('Treffer: [#3] und [#1], nochmal [#3].'), [3, 1]);
  assert.deepEqual(citedIds('Nichts passendes gefunden.'), []);
});

// --- Werkzeug --------------------------------------------------------------

test('readReplyText liefert den vollen Text samt Kopfzeilen', () => {
  const text = readReplyText(replies, 1);
  assert.match(text, /\[#1\] Re: Kurze Frage/);
  assert.match(text, /Anna Müller <anna@example\.com>/);
  assert.match(text, /drei Stellplätze frei/);
});

test('readReplyText kommt mit einer erfundenen Nummer klar', () => {
  assert.match(readReplyText(replies, 99), /keine Antwort mit der Nummer 99/);
});

test('das Werkzeug ist nur lesend und hängt an genau dieser Liste', () => {
  const tool = readReplyTool(replies);
  assert.equal(tool.name, 'read_reply');
  assert.match(tool.run({ id: 2 }), /Bin bis 15\.08\. nicht da\./);
  assert.deepEqual(Object.keys(tool.input_schema.properties), ['id'], 'kein Feld zum Versenden');
});

// --- Zugangsdaten ----------------------------------------------------------

test('fehlender API-Schlüssel wird verständlich gemeldet', () => {
  assert.throws(() => loadAssistantConfig({}), /ANTHROPIC_API_KEY/);
});

test('eine abweichende Basis-Adresse wird übernommen (für Tests und Proxys)', () => {
  const config = loadAssistantConfig({
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100',
  });
  assert.equal(config.baseURL, 'http://127.0.0.1:4100');
});

// --- Frage stellen (mit Doppelgänger statt Netzwerk) ------------------------

/** Baut einen Client, der die Ströme des Tool-Runners nachbildet. */
function fakeClient(turns) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        toolRunner(params) {
          calls.push(params);
          return (async function* () {
            for (const turn of turns) {
              yield {
                async *[Symbol.asyncIterator]() {
                  for (const event of turn.events) yield event;
                },
                async finalMessage() {
                  return { usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 } };
                },
              };
            }
          })();
        },
      },
    },
  };
}

const textEvents = (...stuecke) =>
  stuecke.map((text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } }));

test('die Antwort wird stückweise gemeldet und am Ende zusammengesetzt', async () => {
  const client = fakeClient([{ events: textEvents('Freie Plätze meldet ', 'Anna [#1].') }]);
  const stuecke = [];

  const result = await askAboutReplies({
    client,
    replies,
    question: 'Wer hat freie Plätze?',
    onEvent: (event) => event.type === 'text' && stuecke.push(event.text),
  });

  assert.equal(result.text, 'Freie Plätze meldet Anna [#1].');
  assert.deepEqual(stuecke, ['Freie Plätze meldet ', 'Anna [#1].']);
  assert.deepEqual(result.cited, [1], 'die zitierte Mail wird für die Verlinkung gemeldet');
});

test('ein Werkzeugaufruf wird gemeldet und der zweite Durchlauf mitgelesen', async () => {
  const client = fakeClient([
    {
      events: [
        ...textEvents('Ich schaue nach. '),
        { type: 'content_block_start', content_block: { type: 'tool_use', name: 'read_reply' } },
      ],
    },
    { events: textEvents('Anna [#1] hat drei Plätze.') },
  ]);

  const werkzeuge = [];
  const result = await askAboutReplies({
    client,
    replies,
    question: 'Details?',
    onEvent: (event) => event.type === 'tool' && werkzeuge.push(event.name),
  });

  assert.deepEqual(werkzeuge, ['read_reply']);
  assert.equal(result.text, 'Ich schaue nach. Anna [#1] hat drei Plätze.');
  assert.deepEqual(result.cited, [1]);
});

test('die Anfrage nutzt Opus 5, den Verlauf und das Nur-Lese-Werkzeug', async () => {
  const client = fakeClient([{ events: textEvents('ok') }]);
  const history = [
    { role: 'user', content: 'Erste Frage' },
    { role: 'assistant', content: 'Erste Antwort' },
  ];

  await askAboutReplies({ client, replies, question: 'Zweite Frage', history });

  const params = client.calls[0];
  assert.equal(params.model, 'claude-opus-5');
  assert.deepEqual(params.thinking, { type: 'adaptive' });
  assert.equal(params.stream, true);
  assert.deepEqual(
    params.messages.map((m) => m.content),
    ['Erste Frage', 'Erste Antwort', 'Zweite Frage'],
    'der Verlauf bleibt erhalten',
  );
  assert.deepEqual(
    params.tools.map((t) => t.name),
    ['read_reply'],
  );
});

test('eine leere Frage wird abgelehnt, bevor die API etwas kostet', async () => {
  const client = fakeClient([{ events: textEvents('sollte nie kommen') }]);
  await assert.rejects(() => askAboutReplies({ client, replies, question: '   ' }), /Ohne Frage/);
  assert.equal(client.calls.length, 0);
});

test('ein Abbruch stoppt die Verarbeitung', async () => {
  const controller = new AbortController();
  const client = fakeClient([{ events: textEvents('erstes Stück', 'zweites Stück') }]);

  const result = await askAboutReplies({
    client,
    replies,
    question: 'Test',
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'text') controller.abort();
    },
  });

  assert.equal(result.text, 'erstes Stück', 'nach dem Abbruch kommt nichts mehr dazu');
});
