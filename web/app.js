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
  $$('.step').forEach((el) => el.classList.toggle('active', el.dataset.step === String(n)));
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
