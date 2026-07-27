/**
 * mailmeteor – Oberfläche.
 *
 * Ohne Framework: die Seite hat drei Schritte, einen Zustand und eine
 * Vorschau, die nach jeder Änderung vom Server neu gerendert wird. Das
 * Einsetzen der Platzhalter passiert bewusst serverseitig – so zeigt die
 * Vorschau exakt das, was später auch versendet wird.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const DEMO = `Anna Beispiel <anna.beispiel@example.com>
bernd.muster@example.com; clara.test@example.com
"Söhne, Dirk" <dirk@example.com>`;

const state = {
  campaign: 'kampagne',
  addresses: '',
  subject: '',
  isHtml: true,
  attachments: [],
  resend: false,
  previewIndex: 0,
  lastFocus: 'editor',
  recipients: [],
  smtp: { configured: false },
  running: false,
  controller: null,
};

// ---------------------------------------------------------------- Werkzeug

function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Fehler ${res.status}`);
  return data;
}

/** Der Rumpf, wie er versendet wird: HTML aus dem Editor oder reiner Text. */
function currentBody() {
  if (!state.isHtml) return $('#plainEditor').value;
  return (
    '<div style="font-family:-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif;' +
    'font-size:15px;line-height:1.55;color:#1a1a1a">\n' +
    $('#editor').innerHTML +
    '\n</div>'
  );
}

function payload(extra = {}) {
  return {
    recipientsText: state.addresses,
    subject: state.subject,
    body: currentBody(),
    isHtml: state.isHtml,
    campaign: state.campaign || 'kampagne',
    resend: state.resend,
    from: $('#from').value,
    replyTo: $('#replyTo').value,
    unsubscribe: $('#unsubscribe').value,
    attachments: state.attachments,
    previewIndex: state.previewIndex,
    limits: {
      delayMs: Number($('#delay').value),
      jitterMs: Number($('#jitter').value),
      maxPerRun: Number($('#max').value),
      retries: Number($('#retries').value),
      retryDelayMs: 5000,
    },
    ...extra,
  };
}

// ------------------------------------------------------------- Entwurf merken

const DRAFT_KEY = 'mailmeteor.draft';

function saveDraft() {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        campaign: state.campaign,
        addresses: state.addresses,
        subject: state.subject,
        isHtml: state.isHtml,
        html: $('#editor').innerHTML,
        plain: $('#plainEditor').value,
      }),
    );
  } catch {
    // Speicher voll oder gesperrt – der Entwurf ist Komfort, kein Muss.
  }
}

function restoreDraft() {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
  } catch {
    return;
  }
  if (!draft) return;

  state.campaign = draft.campaign ?? 'kampagne';
  state.addresses = draft.addresses ?? '';
  state.subject = draft.subject ?? '';
  state.isHtml = draft.isHtml !== false;

  $('#campaign').value = state.campaign;
  $('#addresses').value = state.addresses;
  $('#subject').value = state.subject;
  $('#editor').innerHTML = draft.html ?? '';
  $('#plainEditor').value = draft.plain ?? '';
  $('#plainMode').checked = !state.isHtml;
  applyMode();
}

// ------------------------------------------------------------------ Schritte

function showStep(n) {
  // Nur die Schritte des Assistenten – die Kampagnenansicht hat eigene Panels.
  $$('.view[data-view="new"] .step').forEach((el) =>
    el.classList.toggle('active', el.dataset.step === String(n)),
  );
  $$('#stepNav button').forEach((el) => el.classList.toggle('active', el.dataset.step === String(n)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------------ Analyse

const analyze = debounce(async () => {
  try {
    const data = await api('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    state.recipients = data.recipients;
    renderRecipients(data);
    renderPreview(data);
    renderChecklist(data);
  } catch (error) {
    $('#recipientStats').innerHTML = `<span style="color:var(--bad)">${error.message}</span>`;
  }
}, 320);

function renderRecipients(data) {
  const count = data.recipients.length;
  $('#navCount').textContent = count ? `· ${count}` : '';

  const parts = [`<span><b class="good">${count}</b> Empfänger bereit</span>`];
  if (data.alreadySent > 0) {
    parts.push(`<span><b>${data.alreadySent}</b> bereits zugestellt (übersprungen)</span>`);
  }
  if (data.skipped.length > 0) {
    parts.push(`<span><b>${data.skipped.length}</b> aussortiert</span>`);
  }
  if (data.format === 'csv') {
    parts.push(`<span>CSV erkannt: ${data.columns.join(', ')}</span>`);
  }
  $('#recipientStats').innerHTML = parts.join('');

  const shown = data.recipients.slice(0, 60);
  const chips = shown.map((r) => `<span class="chip">${escapeHtml(r.email)}</span>`);
  if (data.recipients.length > shown.length) {
    chips.push(`<span class="chip more">und ${data.recipients.length - shown.length} weitere</span>`);
  }
  $('#chips').innerHTML = chips.join('');

  $('#skipped').innerHTML = data.skipped
    .slice(0, 12)
    .map((s) => `<div class="notice">Zeile ${s.line}: ${escapeHtml(s.reason)}</div>`)
    .join('');

  // Platzhalter-Hinweis: welche Felder stehen zur Verfügung?
  $('#phHint').textContent = data.columns.length
    ? `verfügbar: ${data.columns.map((c) => `{{${c}}}`).join(' ')}`
    : '';
}

function renderPreview(data) {
  const p = data.preview;
  const frame = $('#previewFrame');
  const pre = $('#previewText');

  if (!p) {
    $('#previewTo').textContent = '–';
    $('#previewSubject').textContent = '–';
    frame.srcdoc = '';
    return;
  }

  state.previewIndex = p.index;
  $('#previewFrom').textContent = data.smtp.from || '(MAIL_FROM nicht gesetzt)';
  $('#previewTo').textContent = p.to;
  $('#previewToFoot').textContent = p.to;
  $('#previewSubject').textContent = p.subject || '(kein Betreff)';
  $('#previewIndex').textContent = `${p.index + 1} / ${data.recipients.length || 1}`;

  if (p.html) {
    frame.hidden = false;
    pre.hidden = true;
    frame.srcdoc = p.html;
  } else {
    frame.hidden = true;
    pre.hidden = false;
    pre.textContent = p.text;
  }

  const warn = $('#missingWarn');
  if (p.missing.length > 0) {
    warn.hidden = false;
    warn.textContent = `Ohne Wert für diesen Empfänger: ${p.missing
      .map((m) => `{{${m}}}`)
      .join(', ')} – bleibt so im Text stehen. Standardwert setzen: {{${p.missing[0]}|Hallo}}`;
  } else {
    warn.hidden = true;
  }
}

function renderChecklist(data) {
  const items = [];
  const add = (kind, mark, text) =>
    items.push(
      `<div class="check-item ${kind}"><span class="mark">${mark}</span><span class="grow">${text}</span></div>`,
    );

  const count = data.recipients.length;
  if (count > 0) add('ok', '✓', `<b>${count}</b> Empfänger, jeder bekommt eine eigene Mail (kein BCC).`);
  else add('bad', '✕', 'Keine offenen Empfänger – Adressen einfügen oder „erneut anschreiben" wählen.');

  if (data.smtp.configured) add('ok', '✓', `Absender: <b>${escapeHtml(data.smtp.from)}</b>`);
  else add('bad', '✕', `Kein SMTP-Zugang: ${escapeHtml(data.smtp.error ?? '')} — Probelauf geht trotzdem.`);

  if (state.subject.trim()) add('ok', '✓', `Betreff gesetzt.`);
  else add('warn', '!', 'Kein Betreff. Ohne Betreff wird nicht versendet.');

  if (data.unknownPlaceholders.length > 0) {
    add(
      'warn',
      '!',
      `Platzhalter ohne passendes Feld: ${data.unknownPlaceholders
        .map((p) => `{{${escapeHtml(p)}}}`)
        .join(', ')}`,
    );
  }
  if (data.alreadySent > 0) {
    add('ok', '↻', `<b>${data.alreadySent}</b> Adressen haben diese Kampagne schon – werden übersprungen.`);
  }

  const perMail = (Number($('#delay').value) + Number($('#jitter').value) / 2) / 1000;
  if (count > 1) {
    const minutes = Math.round((count * perMail) / 60);
    const dauer = minutes < 1 ? 'weniger als eine Minute' : `etwa ${minutes} Minute${minutes === 1 ? '' : 'n'}`;
    add('ok', '⏱', `Geschätzte Dauer: ${dauer}.`);
  }
  if (count > 400) {
    add('warn', '!', 'Über 400 Mails: Gmail-Tageslimit beachten (privat ~500, Workspace ~2000).');
  }

  $('#checklist').innerHTML = items.join('');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ------------------------------------------------------------------ Versand

async function run({ dryRun, only = null }) {
  if (state.running) return;

  const body = payload({ dryRun, only });
  state.running = true;
  state.controller = new AbortController();
  $('#btnSend').disabled = true;
  $('#btnDry').disabled = true;
  $('#btnTest').disabled = true;
  $('#btnStop').hidden = dryRun;
  $('#run').hidden = false;
  $('#feed').innerHTML = '';
  $('#progressBar').style.width = '0%';

  const counts = { sent: 0, failed: 0, total: 0 };
  const feedRow = (cls, left, right = '') => {
    const div = document.createElement('div');
    div.className = cls;
    div.innerHTML = `<span>${left}</span><span class="grow">${right}</span>`;
    $('#feed').prepend(div);
    while ($('#feed').childElementCount > 400) $('#feed').lastElementChild.remove();
  };
  const updateCounters = () => {
    $('#counters').innerHTML =
      `<span><b>${counts.sent}</b> ${dryRun ? 'geprüft' : 'versendet'}</span>` +
      (counts.failed ? `<span style="color:var(--bad)"><b>${counts.failed}</b> fehlgeschlagen</span>` : '') +
      `<span>von <b>${counts.total}</b></span>`;
    const done = counts.sent + counts.failed;
    $('#progressBar').style.width = `${counts.total ? (done / counts.total) * 100 : 0}%`;
  };

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: state.controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Fehler ${res.status}`);
    }

    // NDJSON: eine JSON-Zeile pro Ereignis, sofort beim Eintreffen verarbeitet.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = JSON.parse(line);

        if (event.type === 'start') {
          counts.total = event.total;
          updateCounters();
          feedRow('muted', dryRun ? 'Probelauf gestartet' : `Versand gestartet von ${event.from}`);
        } else if (event.type === 'sent') {
          counts.sent++;
          updateCounters();
          feedRow('ok', '✓', event.email);
        } else if (event.type === 'sending' && dryRun) {
          counts.sent++;
          updateCounters();
          feedRow('muted', '›', `${event.email} — Vorschau erzeugt`);
        } else if (event.type === 'failed') {
          counts.failed++;
          updateCounters();
          feedRow('bad', '✕', `${event.email} — ${escapeHtml(event.message)}`);
        } else if (event.type === 'retry') {
          feedRow('muted', '↻', `${event.email} — Versuch ${event.attempt}/${event.retries}`);
        } else if (event.type === 'waiting' && event.nextEmail) {
          feedRow('muted', '…', `${Math.round(event.wait / 1000)} s Pause, dann ${event.nextEmail}`);
        } else if (event.type === 'done') {
          feedRow(
            'muted',
            'Fertig:',
            `${event.sent} ${dryRun ? 'geprüft' : 'versendet'}` +
              (event.failed ? `, ${event.failed} fehlgeschlagen` : '') +
              (event.stopReason ? ` — ${escapeHtml(event.stopReason)}` : ''),
          );
          toast(dryRun ? 'Probelauf abgeschlossen – es wurde nichts versendet.' : 'Versand abgeschlossen.');
        } else if (event.type === 'error') {
          feedRow('bad', '✕', escapeHtml(event.message));
          toast(event.message, 5000);
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      feedRow('muted', 'Gestoppt.', 'Bereits versendete Mails stehen im Protokoll.');
      toast('Gestoppt. Ein erneuter Start macht bei den offenen Adressen weiter.');
    } else {
      toast(error.message, 5000);
      feedRow('bad', '✕', escapeHtml(error.message));
    }
  } finally {
    state.running = false;
    state.controller = null;
    $('#btnSend').disabled = false;
    $('#btnDry').disabled = false;
    $('#btnTest').disabled = false;
    $('#btnStop').hidden = true;
    analyze(); // Protokoll hat sich geändert – Zähler neu holen
  }
}

// ------------------------------------------------------------------- Editor

/** Beim Einfügen aus Word/Web nur einfache Auszeichnungen übernehmen. */
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'A', 'UL', 'OL', 'LI', 'P', 'BR', 'H2', 'H3', 'BLOCKQUOTE']);

function sanitize(node) {
  [...node.childNodes].forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) return;
    if (child.nodeType !== Node.ELEMENT_NODE) return child.remove();

    if (!ALLOWED.has(child.tagName)) {
      // Inhalt behalten, Hülle entfernen
      while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
      return child.remove();
    }

    [...child.attributes].forEach((attr) => {
      const keep = child.tagName === 'A' && attr.name === 'href' && /^(https?:|mailto:)/i.test(attr.value);
      if (!keep) child.removeAttribute(attr.name);
    });
    if (child.tagName === 'A') {
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener');
    }
    sanitize(child);
  });
}

function insertAtCursor(text) {
  // In das Feld einsetzen, in dem zuletzt geschrieben wurde – sonst landet
  // {{vorname}} im Rumpf, obwohl der Betreff gemeint war.
  const target = state.lastFocus === 'subject' ? $('#subject') : state.isHtml ? $('#editor') : $('#plainEditor');
  target.focus();

  if (target !== $('#editor')) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.value = target.value.slice(0, start) + text + target.value.slice(end);
    target.selectionStart = target.selectionEnd = start + text.length;
    if (target === $('#subject')) state.subject = target.value;
    onContentChanged();
    return;
  }

  const selection = window.getSelection();
  if (!selection.rangeCount || !$('#editor').contains(selection.anchorNode)) {
    $('#editor').append(document.createTextNode(text));
  } else {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  onContentChanged();
}

function applyMode() {
  const html = state.isHtml;
  $('#editor').hidden = !html;
  $('#plainEditor').hidden = html;
  $$('#toolbar button').forEach((b) => (b.disabled = !html));
}

function onContentChanged() {
  saveDraft();
  analyze();
}

// --------------------------------------------------------------------- Start

function bind() {
  // Schritte
  $$('#stepNav button').forEach((b) => b.addEventListener('click', () => showStep(b.dataset.step)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showStep(b.dataset.goto)));

  // Schritt 1
  $('#addresses').addEventListener('input', (e) => {
    state.addresses = e.target.value;
    onContentChanged();
  });
  $('#btnDemo').addEventListener('click', () => {
    $('#addresses').value = DEMO;
    state.addresses = DEMO;
    onContentChanged();
  });
  $('#resend').addEventListener('change', (e) => {
    state.resend = e.target.checked;
    analyze();
  });
  $('#campaign').addEventListener('input', (e) => {
    state.campaign = e.target.value;
    onContentChanged();
  });

  // Schritt 2
  $('#subject').addEventListener('input', (e) => {
    state.subject = e.target.value;
    onContentChanged();
  });
  $('#editor').addEventListener('input', onContentChanged);
  $('#subject').addEventListener('focus', () => (state.lastFocus = 'subject'));
  $('#editor').addEventListener('focus', () => (state.lastFocus = 'editor'));
  $('#plainEditor').addEventListener('focus', () => (state.lastFocus = 'editor'));
  $('#plainEditor').addEventListener('input', onContentChanged);

  $('#editor').addEventListener('paste', (event) => {
    event.preventDefault();
    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');
    if (html) {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      sanitize(holder);
      document.execCommand('insertHTML', false, holder.innerHTML);
    } else {
      document.execCommand('insertText', false, text);
    }
  });

  $$('#toolbar button[data-cmd]').forEach((button) => {
    button.addEventListener('click', () => {
      $('#editor').focus();
      document.execCommand(button.dataset.cmd, false, button.dataset.value ?? null);
      onContentChanged();
    });
  });

  $('#btnLink').addEventListener('click', () => {
    const url = prompt('Adresse des Links (https://… oder mailto:…)');
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url)) return toast('Nur http(s)- und mailto-Links.');
    $('#editor').focus();
    document.execCommand('createLink', false, url);
    onContentChanged();
  });

  $('#plainMode').addEventListener('change', (e) => {
    state.isHtml = !e.target.checked;
    applyMode();
    onContentChanged();
  });

  $$('.placeholders button[data-ph]').forEach((b) =>
    b.addEventListener('click', () => insertAtCursor(`{{${b.dataset.ph}}}`)),
  );

  $('#templateSelect').addEventListener('change', async (e) => {
    const name = e.target.value;
    if (!name) return;
    const tpl = await api(`/api/template?name=${encodeURIComponent(name)}`);
    state.subject = tpl.subject;
    state.isHtml = tpl.isHtml;
    $('#subject').value = tpl.subject;
    $('#plainMode').checked = !tpl.isHtml;
    if (tpl.isHtml) $('#editor').innerHTML = tpl.body;
    else $('#plainEditor').value = tpl.body;
    applyMode();
    onContentChanged();
  });

  $('#attachInput').addEventListener('change', async (event) => {
    for (const file of event.target.files) {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      state.attachments.push({ filename: file.name, contentBase64: base64, size: file.size });
    }
    event.target.value = '';
    renderAttachments();
  });

  // Schritt 3
  ['#delay', '#jitter', '#max', '#retries', '#from', '#replyTo', '#unsubscribe'].forEach((sel) =>
    $(sel).addEventListener('input', analyze),
  );

  $('#btnDry').addEventListener('click', () => run({ dryRun: true }));
  $('#btnStop').addEventListener('click', () => state.controller?.abort());

  $('#btnTest').addEventListener('click', () => {
    const address = $('#testAddress').value.trim();
    if (!address) return toast('Erst eine Adresse für die Testmail eintragen.');
    run({ dryRun: false, only: address });
  });

  $('#btnSend').addEventListener('click', async () => {
    const count = state.recipients.length;
    if (count === 0) return toast('Keine offenen Empfänger.');
    if (!state.subject.trim()) return toast('Ohne Betreff wird nicht versendet.');
    if (!state.smtp.configured) return toast('Kein SMTP-Zugang – bitte .env anlegen.');

    $('#confirmText').textContent =
      `${count} Mail${count === 1 ? '' : 's'} ${count === 1 ? 'geht' : 'gehen'} einzeln von ` +
      `${state.smtp.from} raus, mit Pause dazwischen. Der Lauf lässt sich jederzeit stoppen.`;
    const dialog = $('#confirmDialog');
    dialog.showModal();
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue === 'ok') run({ dryRun: false });
      },
      { once: true },
    );
  });

  // Strg-Enter im Editor springt zum Prüfen
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') showStep(3);
  });
}

function renderAttachments() {
  $('#attachList').innerHTML = state.attachments
    .map(
      (a, i) =>
        `<span class="attach">${escapeHtml(a.filename)} <span style="color:var(--ink-soft)">${Math.round(
          a.size / 1024,
        )} kB</span> <button type="button" data-i="${i}">✕</button></span>`,
    )
    .join('');

  $$('#attachList button').forEach((b) =>
    b.addEventListener('click', () => {
      state.attachments.splice(Number(b.dataset.i), 1);
      renderAttachments();
      analyze();
    }),
  );
}

async function init() {
  bind();
  restoreDraft();

  try {
    const data = await api('/api/state');
    state.smtp = data.smtp.configured ? { configured: true, from: data.smtp.from } : { configured: false };

    const pill = $('#smtpStatus');
    if (data.smtp.configured) {
      pill.className = 'pill pill-ok';
      pill.textContent = `Bereit · ${data.smtp.from}`;
      pill.title = `${data.smtp.host}:${data.smtp.port} als ${data.smtp.user}`;
    } else {
      pill.className = 'pill pill-bad';
      pill.textContent = 'Kein SMTP-Zugang · nur Probelauf';
      pill.title = data.smtp.error ?? '';
    }

    // Postfach und KI: nur ob eingerichtet – Zugangsdaten bleiben am Server.
    const ai = $('#aiStatus');
    const bereit = data.imap?.configured && data.assistant?.configured;
    ai.className = `pill ${bereit ? 'pill-ok' : 'pill-muted'}`;
    ai.textContent = bereit
      ? 'Antworten + KI bereit'
      : !data.imap?.configured
        ? 'Kein Postfach-Zugang'
        : 'Kein API-Schlüssel';
    ai.title = [data.imap?.error, data.assistant?.error].filter(Boolean).join(' · ');

    $('#templateSelect').innerHTML =
      '<option value="">– keine –</option>' +
      data.templates.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  } catch (error) {
    toast(`Server nicht erreichbar: ${error.message}`, 6000);
  }

  $('#prevBtn').addEventListener('click', () => {
    state.previewIndex = Math.max(0, state.previewIndex - 1);
    analyze();
  });
  $('#nextBtn').addEventListener('click', () => {
    state.previewIndex = Math.min(Math.max(0, state.recipients.length - 1), state.previewIndex + 1);
    analyze();
  });

  analyze();
}

init();

// ==========================================================================
// Schritt 4: Antworten abrufen, lesen, beantworten – und durchsuchen lassen
// ==========================================================================

const replyState = {
  campaign: null, // welche Kampagne gerade offen ist
  replies: [],
  selected: null,
  history: [], // Chatverlauf für Rückfragen
  chatController: null,
  busy: false,
};

function campaignParam() {
  return encodeURIComponent(replyState.campaign ?? state.campaign ?? 'kampagne');
}

function currentCampaign() {
  return replyState.campaign ?? state.campaign ?? 'kampagne';
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --------------------------------------------------------------- Übersicht

async function loadReplies() {
  try {
    const data = await api(`/api/replies?campaign=${campaignParam()}`);
    replyState.replies = data.replies;
    renderReplyList(data);
  } catch (error) {
    $('#replyStats').innerHTML = `<span style="color:var(--bad)">${escapeHtml(error.message)}</span>`;
  }
}

function renderReplyList(data) {
    const parts = [];
  if (data.total > 0) {
    const echte = data.total - data.automatic;
    parts.push(`<span><b>${echte}</b> echte Antwort${echte === 1 ? '' : 'en'}</span>`);
    if (data.automatic) {
      parts.push(
        `<span><b>${data.automatic}</b> Abwesenheitsnotiz${data.automatic === 1 ? '' : 'en'}</span>`,
      );
    }
    if (data.answered) parts.push(`<span><b>${data.answered}</b> beantwortet</span>`);
  } else {
    parts.push('<span>Noch nichts abgerufen.</span>');
  }
  if (data.lastSyncAt) parts.push(`<span>zuletzt geholt: ${formatDate(data.lastSyncAt)}</span>`);
  $('#replyStats').innerHTML = parts.join('');

  $('#chatNote').textContent = data.total
    ? `${data.total} Antworten durchsuchbar`
    : 'Erst abrufen, dann durchsuchbar';

  $('#replyList').innerHTML = data.replies.length
    ? data.replies
        .map((reply) => {
          const wer = reply.from.name || reply.from.address;
          const tags = [
            `<span class="tag">#${reply.id}</span>`,
            reply.isAutomatic ? '<span class="tag auto">automatisch</span>' : '',
            reply.answered ? '<span class="tag done">beantwortet</span>' : '',
            reply.matchedBy === 'address' ? '<span class="tag">über Adresse</span>' : '',
          ].join('');

          return `<button type="button" class="reply-item" data-id="${reply.id}">
            <span class="who">${escapeHtml(wer)}<span class="when">${formatDate(reply.date)}</span></span>
            <span class="subject">${escapeHtml(reply.subject)}</span>
            <span class="snippet">${escapeHtml(reply.snippet ?? '')}</span>
            <span class="tags">${tags}</span>
          </button>`;
        })
        .join('')
    : '<p class="empty-hint" style="padding:14px">Noch keine Antworten abgerufen.</p>';

  $$('#replyList .reply-item').forEach((button) =>
    button.addEventListener('click', () => openReply(Number(button.dataset.id))),
  );
}

// ------------------------------------------------------------------ Detail

async function openReply(id) {
  showStep(4);
  $$('#replyList .reply-item').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.id) === id),
  );

  let reply;
  try {
    reply = await api(`/api/reply?campaign=${campaignParam()}&id=${id}`);
  } catch (error) {
    return toast(error.message, 4000);
  }
  replyState.selected = reply;

  const wer = reply.from.name
    ? `${reply.from.name} <${reply.from.address}>`
    : reply.from.address;

  // HTML-Mails im abgeschotteten Rahmen: fremdes Markup darf hier nichts tun.
  const body = reply.html
    ? `<iframe sandbox="" title="Inhalt der Antwort"></iframe>`
    : `<div>${escapeHtml(reply.text || '(kein Text)')}</div>`;

  $('#replyDetail').innerHTML = `
    <h3>${escapeHtml(reply.subject)}</h3>
    <div class="meta">Von ${escapeHtml(wer)} · ${formatDate(reply.date)}${
      reply.isAutomatic ? ' · automatische Antwort' : ''
    }</div>
    <div class="reply-body">${body}</div>
    <div class="answer-box">
      <label class="field">
        <span>Antwort an ${escapeHtml(reply.from.address)}</span>
        <textarea id="answerText" rows="4" placeholder="Deine Antwort …"></textarea>
      </label>
      <div class="row end">
        <button type="button" class="primary" id="btnAnswer">Antwort senden</button>
      </div>
    </div>`;

  if (reply.html) $('#replyDetail iframe').srcdoc = reply.html;
  $('#btnAnswer').addEventListener('click', () => sendAnswer(reply.id));
  $('#replyDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function sendAnswer(id) {
  const text = $('#answerText').value.trim();
  if (!text) return toast('Ohne Text wird nichts verschickt.');

  const button = $('#btnAnswer');
  button.disabled = true;
  button.textContent = 'Wird gesendet …';

  try {
    const result = await api('/api/replies/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campaign: currentCampaign(), id, text }),
    });
    toast(`Antwort an ${result.to} ist raus.`);
    await loadReplies();
    await openReply(id);
  } catch (error) {
    toast(error.message, 5000);
    button.disabled = false;
    button.textContent = 'Antwort senden';
  }
}

// ------------------------------------------------------------------- Abruf

async function syncReplies() {
  const button = $('#btnSync');
  button.disabled = true;
  button.textContent = 'Wird abgerufen …';
  $('#syncFeed').hidden = false;
  $('#syncFeed').innerHTML = '';

  const row = (text) => {
    const div = document.createElement('div');
    div.innerHTML = `<span class="muted">${text}</span>`;
    $('#syncFeed').prepend(div);
  };

  try {
    const res = await fetch('/api/replies/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campaign: currentCampaign() }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Fehler ${res.status}`);

    await readNdjson(res, (event) => {
      if (event.type === 'connected') row(`Mit ${escapeHtml(event.host)} verbunden.`);
      else if (event.type === 'progress') row(`${event.checked} Mails geprüft, ${event.matched} zugeordnet …`);
      else if (event.type === 'match') row(`Antwort von ${escapeHtml(event.email)}`);
      else if (event.type === 'done') {
        row(`Fertig: ${event.matched} Antworten aus ${event.checked} geprüften Mails.`);
        toast(`${event.matched} Antworten abgerufen.`);
      } else if (event.type === 'error') {
        row(`Fehler: ${escapeHtml(event.message)}`);
        toast(event.message, 6000);
      }
    });

    await loadReplies();
  } catch (error) {
    toast(error.message, 6000);
    row(`Fehler: ${escapeHtml(error.message)}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Antworten abrufen';
  }
}

/** Liest einen NDJSON-Strom Zeile für Zeile. */
async function readNdjson(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

// -------------------------------------------------------------------- Chat

/** Macht aus "[#3]" einen Knopf, der die Mail öffnet. */
function renderWithCitations(text) {
  return escapeHtml(text).replace(
    /\[#(\d+)\]/g,
    (_, id) => `<button type="button" class="cite" data-cite="${id}">#${id}</button>`,
  );
}

function chatBubble(kind, html) {
  const div = document.createElement('div');
  div.className = `bubble ${kind}`;
  div.innerHTML = html;
  $('#chatLog').append(div);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  return div;
}

function bindCitations(element) {
  element.querySelectorAll('[data-cite]').forEach((button) =>
    button.addEventListener('click', () => openReply(Number(button.dataset.cite))),
  );
}

async function askAssistant(question) {
  if (replyState.busy) return;
  replyState.busy = true;
  replyState.chatController = new AbortController();
  $('#btnAsk').disabled = true;
  $('#btnStopChat').hidden = false;

  chatBubble('me', escapeHtml(question));
  let text = '';
  let toolNote = null;
  const answer = chatBubble('ai', '<span class="muted">denkt nach …</span>');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        campaign: currentCampaign(),
        question,
        history: replyState.history,
      }),
      signal: replyState.chatController.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Fehler ${res.status}`);

    await readNdjson(res, (event) => {
      if (event.type === 'text') {
        text += event.text;
        answer.innerHTML = renderWithCitations(text);
        $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
      } else if (event.type === 'tool') {
        if (!toolNote) {
          // Vor die laufende Antwort setzen: der Nachschlag kam ja zuerst.
          toolNote = document.createElement('div');
          toolNote.className = 'bubble tool';
          toolNote.textContent = '↻ liest eine Antwort im Volltext nach …';
          answer.before(toolNote);
        }
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    });

    if (!text.trim()) answer.innerHTML = '<span class="muted">(keine Antwort erhalten)</span>';
    bindCitations(answer);

    // Verlauf mitführen, damit Rückfragen den Zusammenhang behalten.
    replyState.history.push({ role: 'user', content: question });
    replyState.history.push({ role: 'assistant', content: text });
  } catch (error) {
    if (error.name === 'AbortError') {
      answer.innerHTML += ' <span class="muted">(gestoppt)</span>';
      bindCitations(answer);
    } else {
      answer.innerHTML = `<span style="color:var(--bad)">${escapeHtml(error.message)}</span>`;
    }
  } finally {
    replyState.busy = false;
    replyState.chatController = null;
    $('#btnAsk').disabled = false;
    $('#btnStopChat').hidden = true;
  }
}

// ------------------------------------------------------------------ Bindung

function bindReplies() {
  $('#btnSync').addEventListener('click', syncReplies);
  $('#btnStopChat').addEventListener('click', () => replyState.chatController?.abort());

  $('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const question = $('#chatQuestion').value.trim();
    if (!question) return;
    $('#chatQuestion').value = '';
    askAssistant(question);
  });

}

bindReplies();

// ==========================================================================
// Bereiche: Assistent für eine neue Kampagne – und die Liste der bisherigen
// ==========================================================================

function showView(name) {
  $$('.view').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  $$('#viewNav button').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'list') loadCampaigns();
}

// ------------------------------------------------------------------- Liste

async function loadCampaigns() {
  let data;
  try {
    data = await api('/api/campaigns');
  } catch (error) {
    return toast(error.message, 5000);
  }

  $('#campaignCount').textContent = data.campaigns.length ? `· ${data.campaigns.length}` : '';

  if (data.campaigns.length === 0) {
    $('#campaignList').innerHTML = `<p class="empty-hint">
      Noch keine Kampagne versendet. Eine Kampagne wird angelegt, sobald du im Assistenten
      wirklich sendest – ein Probelauf legt nichts an.</p>`;
    return;
  }

  $('#campaignList').innerHTML = data.campaigns
    .map((c) => {
      const zahlen = [
        `<span><b>${c.sent}</b> zugestellt</span>`,
        c.failed ? `<span style="color:var(--bad)"><b>${c.failed}</b> fehlgeschlagen</span>` : '',
        c.open ? `<span><b>${c.open}</b> offen</span>` : '',
        c.replies ? `<span style="color:var(--ok)"><b>${c.replies}</b> Antworten</span>` : '',
      ]
        .filter(Boolean)
        .join('');

      return `<button type="button" class="campaign-card" data-name="${escapeHtml(c.name)}">
        <span class="campaign-head">
          <b>${escapeHtml(c.name)}</b>
          <span class="when">${c.lastActivityAt ? formatDate(c.lastActivityAt) : ''}</span>
        </span>
        <span class="campaign-subject">${escapeHtml(c.subject || '(kein Betreff gespeichert)')}</span>
        <span class="stats">${zahlen}</span>
        ${c.hasManifest ? '' : '<span class="tag">nur Protokoll – vor dieser Version versendet</span>'}
      </button>`;
    })
    .join('');

  $$('#campaignList .campaign-card').forEach((card) =>
    card.addEventListener('click', () => openCampaign(card.dataset.name)),
  );
}

// ------------------------------------------------------------------ Detail

async function openCampaign(name) {
  let data;
  try {
    data = await api(`/api/campaign?name=${encodeURIComponent(name)}`);
  } catch (error) {
    return toast(error.message, 5000);
  }

  replyState.campaign = name;
  replyState.history = []; // Chatverlauf gehört zur Kampagne, nicht zur Sitzung
  replyState.selected = null;

  $('#campaignListPanel').hidden = true;
  $('#campaignDetailPanel').hidden = false;
  $('#detailName').textContent = name;

  const summe = [
    `<span><b>${data.sent}</b> zugestellt</span>`,
    data.failed ? `<span style="color:var(--bad)"><b>${data.failed}</b> fehlgeschlagen</span>` : '',
    data.open ? `<span><b>${data.open}</b> offen</span>` : '',
    data.createdAt ? `<span>angelegt ${formatDate(data.createdAt)}</span>` : '',
  ].filter(Boolean);
  $('#detailSummary').innerHTML = summe.join('');

  // Verschickte Mail
  const manifest = data.manifest;
  $('#detailFrom').textContent = manifest?.from || '–';
  $('#detailSubject').textContent = manifest?.subject || '(nicht gespeichert)';

  if (manifest?.isHtml && manifest.body) {
    $('#detailFrame').hidden = false;
    $('#detailText').hidden = true;
    $('#detailFrame').srcdoc = manifest.body;
  } else {
    $('#detailFrame').hidden = true;
    $('#detailText').hidden = false;
    $('#detailText').textContent =
      manifest?.body ||
      'Für diese Kampagne wurde der Mailtext nicht gespeichert – sie stammt aus einer Version vor dieser Funktion.';
  }

  // Empfänger mit Stand
  $('#detailRecipients').innerHTML = data.recipients.length
    ? data.recipients
        .map((r) => {
          const zeichen =
            r.status === 'zugestellt' ? '✓' : r.status === 'fehlgeschlagen' ? '✕' : '·';
          return `<div class="recipient-row ${r.status}">
            <span class="mark">${zeichen}</span>
            <span class="addr">${escapeHtml(r.email)}</span>
            <span class="state">${r.status}${r.error ? ` – ${escapeHtml(r.error)}` : ''}</span>
          </div>`;
        })
        .join('')
    : '<p class="empty-hint">Keine Empfänger gespeichert.</p>';

  $('#btnResume').hidden = !manifest;
  $('#btnResume').dataset.name = name;

  // Antworten und Chat beziehen sich ab jetzt auf diese Kampagne
  $('#chatLog').querySelectorAll('.bubble').forEach((b) => b.remove());
  $('#replyDetail').innerHTML = '<p class="empty-hint">Links eine Antwort auswählen, um sie hier zu lesen.</p>';
  await loadReplies();
}

/** Lädt eine gespeicherte Kampagne zurück in den Assistenten. */
async function resumeCampaign(name) {
  const data = await api(`/api/campaign?name=${encodeURIComponent(name)}`);
  const manifest = data.manifest;
  if (!manifest) return toast('Für diese Kampagne ist kein Inhalt gespeichert.');

  state.campaign = name;
  state.subject = manifest.subject;
  state.isHtml = manifest.isHtml;
  state.addresses = manifest.recipients.map((r) => r.email).join('\n');

  $('#campaign').value = name;
  $('#subject').value = manifest.subject;
  $('#addresses').value = state.addresses;
  $('#plainMode').checked = !manifest.isHtml;
  if (manifest.isHtml) $('#editor').innerHTML = manifest.body;
  else $('#plainEditor').value = manifest.body;
  applyMode();

  showView('new');
  showStep(1);
  onContentChanged();
  toast(`"${name}" geladen. Bereits zugestellte Adressen werden übersprungen.`);
}

// ------------------------------------------------------------------ Bindung

function bindViews() {
  $$('#viewNav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  $('#btnBackToList').addEventListener('click', () => {
    $('#campaignDetailPanel').hidden = true;
    $('#campaignListPanel').hidden = false;
    replyState.campaign = null;
    loadCampaigns();
  });

  $('#btnResume').addEventListener('click', (event) =>
    resumeCampaign(event.currentTarget.dataset.name).catch((error) => toast(error.message, 5000)),
  );

  // Ohne eingetippten Namen einen aus dem Betreff vorschlagen – sonst landet
  // alles in einer Sammelkampagne namens "kampagne".
  let nameVonHand = false;
  $('#campaign').addEventListener('input', () => {
    nameVonHand = $('#campaign').value.trim() !== '';
  });
  $('#subject').addEventListener('input', () => {
    if (nameVonHand || !state.subject) return;
    // Umlaute umschreiben statt wegwerfen: der Server entschärft den Namen
    // ohnehin, so bleibt der angezeigte Name derselbe wie der gespeicherte.
    const vorschlag = state.subject
      .toLowerCase()
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '');
    if (!vorschlag) return;
    $('#campaign').value = vorschlag;
    state.campaign = vorschlag;
    $('#campaignNote').textContent = 'Name aus dem Betreff vorgeschlagen – änderbar.';
    saveDraft();
  });
}

bindViews();
