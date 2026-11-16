// ==UserScript==
// @name         Garmin Lifestyle Logging → Google Sheet
// @namespace    garmin-sheet-sync.lifestyle
// @version      1.0.0
// @description  Reads caffeine and alcohol from Garmin Connect's Lifestyle Logging in your signed-in tab and submits them to the same Google Form as garmin-sheet-sync.mjs.
// @match        https://connect.garmin.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      docs.google.com
// @run-at       document-idle
// ==/UserScript==

// Why a userscript: Garmin's official Personal API doesn't offer Lifestyle Logging, so this reads
// the endpoint the Garmin Connect web app itself uses, with your existing session. Nothing is
// stored in this file: the form link lives in Tampermonkey's storage (menu → "Set form link").
//
// Rows are filed under the calendar day the behavior happened. Its effect shows up in the next
// morning's HRV and sleep, which Garmin files under the following date: shift by one day when
// analyzing.

(function () {
  'use strict';

  const SETTINGS = {
    firstRunDays: 90,       // how far back the first sync looks
    windowDays: 14,         // later syncs re-check this many days, since logs are often added or edited late
    autoSyncMinHours: 6,    // sync on page load if the last sync was longer ago than this
    requestDelayMs: 300,    // pause between Garmin requests and between form submissions
    lateCaffeineHour: 14,   // caffeine logged at or after this local hour counts as late
  };

  // Behaviors are matched by name, as shown in the Garmin Connect app. Adjust for custom names.
  const CAFFEINE = /caffeine|coffee|espresso/i;
  const LATE = /late|afternoon|evening|night/i;
  const ALCOHOL = /alcohol|beer|wine|liquor|cocktail/i;

  // Form questions this script fills, besides `date`. Titles must match the form exactly.
  const FIELDS = ['date', 'caffeine', 'caffeine_amount', 'caffeine_late', 'alcohol', 'alcohol_drinks'];

  const API = 'https://connect.garmin.com/gc-api';
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Dates (local calendar days, as Garmin files them)
  // ---------------------------------------------------------------------------
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  // ---------------------------------------------------------------------------
  // Garmin (same-origin requests with your session)
  // ---------------------------------------------------------------------------
  function csrfToken() {
    for (const s of ['meta[name="csrf-token"]', 'meta[name="_csrf"]', 'meta[name="connect-csrf-token"]']) {
      const m = document.querySelector(s);
      if (m && m.content) return m.content;
    }
    return null;
  }

  async function getJSON(path) {
    const headers = { Accept: 'application/json', nk: 'NT' };
    const tok = csrfToken();
    if (tok) headers['connect-csrf-token'] = tok;
    const res = await fetch(API + path, { credentials: 'include', headers });
    if (res.status === 204 || res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new Error('Garmin refused the request: sign in to Garmin Connect again and reload.');
    if (!res.ok) throw new Error(`Garmin returned ${res.status} for ${path}`);
    return res.json();
  }

  const fetchDay = (date) => getJSON(`/lifestylelogging-service/dailyLog/${date}`);

  // ---------------------------------------------------------------------------
  // Parsing. Garmin doesn't document this response; the expected shape, from open-source
  // clients, is { dailyLogsReport: [{ name, logStatus: "YES"|"NO"|absent, measurementType,
  // details: [{ amount, ...time fields? }] }] }. Unknown shapes produce blanks, never guesses.
  // ---------------------------------------------------------------------------
  function entriesOf(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.dailyLogsReport)) return payload.dailyLogsReport;
    return [];
  }
  const nameOf = (e) => String((e && (e.name || e.behaviourName || e.behaviorName)) || '').trim();
  const statusOf = (e) => {
    const s = String((e && e.logStatus) || '').toUpperCase();
    return s === 'YES' || s === 'NO' ? s : null; // absent = not answered that day
  };
  const detailsOf = (e) => (e && Array.isArray(e.details) ? e.details : []);

  function amountOf(e) {
    let total = 0, found = false;
    for (const d of detailsOf(e)) {
      const v = d && d.amount;
      if (typeof v === 'number' && Number.isFinite(v)) { total += v; found = true; }
    }
    return found ? total : null;
  }

  // Local clock hours of any timestamps in an entry's details, if Garmin includes them.
  function hoursOf(e) {
    const out = [];
    for (const d of detailsOf(e)) {
      if (!d || typeof d !== 'object') continue;
      for (const [k, v] of Object.entries(d)) {
        if (typeof v !== 'string') continue;
        const m = v.match(/^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
        if (!m) continue;
        if (/gmt|utc/i.test(k) || /Z$/.test(v)) {
          const t = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(v) ? v : v.replace(' ', 'T') + 'Z');
          if (!isNaN(t)) out.push(t.getHours() + t.getMinutes() / 60);
        } else {
          out.push(Number(m[1]) + Number(m[2]) / 60);
        }
      }
    }
    return out;
  }

  function summarize(payload) {
    const entries = entriesOf(payload);
    const caffeine = entries.filter((e) => CAFFEINE.test(nameOf(e)));
    const alcohol = entries.filter((e) => ALCOHOL.test(nameOf(e)) && !CAFFEINE.test(nameOf(e)));
    const r = {};

    // Caffeine: yes if any caffeine behavior is YES; no if answered and none is YES.
    const cafAnswered = caffeine.filter((e) => statusOf(e));
    const cafYes = caffeine.filter((e) => statusOf(e) === 'YES');
    r.caffeine = cafYes.length ? 'yes' : cafAnswered.length ? 'no' : '';
    if (r.caffeine === 'no') r.caffeine_amount = 0;
    else if (r.caffeine === 'yes') {
      const amounts = cafYes.map(amountOf).filter((v) => v !== null);
      r.caffeine_amount = amounts.length ? amounts.reduce((a, b) => a + b, 0) : '';
    }
    // Late caffeine: from a behavior named like "Late caffeine", else from logged times.
    const lateNamed = caffeine.filter((e) => LATE.test(nameOf(e)) && statusOf(e));
    const times = cafYes.flatMap(hoursOf);
    if (r.caffeine === 'no') r.caffeine_late = 'no';
    else if (lateNamed.some((e) => statusOf(e) === 'YES')) r.caffeine_late = 'yes';
    else if (times.length) r.caffeine_late = times.some((h) => h >= SETTINGS.lateCaffeineHour) ? 'yes' : 'no';
    else if (lateNamed.length) r.caffeine_late = 'no';
    else r.caffeine_late = '';

    // Alcohol: yes/no, plus the number of drinks if it's logged as a quantity.
    const alcAnswered = alcohol.filter((e) => statusOf(e));
    const alcYes = alcohol.filter((e) => statusOf(e) === 'YES');
    r.alcohol = alcYes.length ? 'yes' : alcAnswered.length ? 'no' : '';
    if (r.alcohol === 'no') r.alcohol_drinks = 0;
    else if (r.alcohol === 'yes') {
      const amounts = alcYes.map(amountOf).filter((v) => v !== null);
      r.alcohol_drinks = amounts.length ? amounts.reduce((a, b) => a + b, 0) : '';
    }
    return r;
  }

  // ---------------------------------------------------------------------------
  // Google Form. The link is stored in Tampermonkey, never in this file.
  // ---------------------------------------------------------------------------
  function formSetup() {
    const link = GM_getValue('prefillUrl', '');
    if (!link) throw new Error('Set the form link first: Tampermonkey menu → "Set form link".');
    const u = new URL(link);
    if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !u.pathname.startsWith('/forms/') || !/\/viewform$/.test(u.pathname)) {
      throw new Error('The form link must be a https://docs.google.com/forms/…/viewform pre-filled link.');
    }
    const map = {};
    for (const [k, v] of u.searchParams) if (k.startsWith('entry.')) map[v.trim()] = k;
    const missing = FIELDS.filter((f) => !map[f]);
    if (missing.length) throw new Error(`The form link is missing: ${missing.join(', ')}. Add those questions and make a new pre-filled link.`);
    return { action: u.origin + u.pathname.replace(/\/viewform$/, '/formResponse'), map };
  }

  function submitRow(form, row) {
    const body = new URLSearchParams();
    for (const f of FIELDS) {
      const v = row[f];
      if (v !== undefined && v !== null && v !== '') body.append(form.map[f], String(v));
    }
    body.append('fvv', '1');
    body.append('pageHistory', '0');
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: form.action,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: body.toString(),
        anonymous: true, // don't send your Google cookies
        onload: (r) => {
          const html = r.responseText || '';
          // Google answers 200 even when it rejects a response, so look for the confirmation page.
          if (r.status === 200 && /freebirdFormviewerViewResponseConfirmationMessage|response has been recorded/i.test(html)
              && !/accounts\.google\.com/.test(r.finalUrl || '')) return resolve();
          reject(new Error(`Google Form rejected ${row.date} (${r.status}): check that the form accepts responses without sign-in.`));
        },
        onerror: () => reject(new Error('Network error submitting to Google Form')),
      });
    });
  }

  const fingerprint = (row) => FIELDS.map((f) => row[f] ?? '').join('|');

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------
  let running = false;

  async function sync({ days } = {}) {
    if (running) return;
    running = true;
    try {
      const form = formSetup();
      const today = parseYmd(ymd(new Date()));
      const sent = GM_getValue('sent', {});
      const span = days || (Object.keys(sent).length ? SETTINGS.windowDays : SETTINGS.firstRunDays);
      let submitted = 0, unchanged = 0, empty = 0;

      for (let i = span - 1; i >= 0; i--) {
        const date = ymd(addDays(today, -i));
        status(`Lifestyle ${date}…`);
        const row = { date, ...summarize(await fetchDay(date)) };
        await pause(SETTINGS.requestDelayMs);
        if (FIELDS.every((f) => f === 'date' || row[f] === '' || row[f] === undefined)) { empty++; continue; }
        if (sent[date] === fingerprint(row)) { unchanged++; continue; }
        await submitRow(form, row);
        sent[date] = fingerprint(row);
        GM_setValue('sent', sent); // save as we go so a failure mid-run doesn't resend
        submitted++;
        await pause(SETTINGS.requestDelayMs);
      }
      GM_setValue('lastSyncAt', Date.now());
      status(`✓ Lifestyle: ${submitted} sent, ${unchanged} unchanged, ${empty} not logged`);
    } catch (e) {
      status(`✗ ${e.message}`, true);
    } finally {
      running = false;
    }
  }

  // Shows one day's raw response in this browser's console, to check the parsing. It contains
  // your own logs: don't paste it into public places (issues, PRs, commits).
  async function inspect() {
    const date = prompt('Show the raw Lifestyle Logging response for which date? (YYYY-MM-DD)', ymd(addDays(new Date(), -1)));
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const payload = await fetchDay(date);
    console.log(`[lifestyle-sync] raw response for ${date}:`, JSON.stringify(payload, null, 2));
    console.log(`[lifestyle-sync] parsed row for ${date}:`, JSON.stringify({ date, ...summarize(payload) }));
    status(`Printed ${date} to the console (F12 → Console)`);
  }

  function setFormLink() {
    const link = prompt('Paste the Google Form pre-filled link (it stays in Tampermonkey, not in the script):', GM_getValue('prefillUrl', ''));
    if (link === null) return;
    GM_setValue('prefillUrl', link.trim());
    try { formSetup(); status('Form link saved'); } catch (e) { status(`✗ ${e.message}`, true); }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  let label;
  function status(msg, isErr) {
    if (label) { label.textContent = msg; label.style.color = isErr ? '#ffd27a' : '#fff'; }
  }

  function mount() {
    if (document.getElementById('lifestyle-sync-box')) return;
    const box = document.createElement('div');
    box.id = 'lifestyle-sync-box';
    box.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:99999;background:#1f2937;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center;max-width:340px';
    const btn = document.createElement('button');
    btn.textContent = 'Lifestyle → Sheet';
    btn.style.cssText = 'background:#2563eb;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit';
    btn.onclick = () => sync();
    label = document.createElement('span');
    label.textContent = GM_getValue('prefillUrl', '') ? 'Ready' : 'Set the form link in the Tampermonkey menu';
    box.append(btn, label);
    document.body.appendChild(box);
  }

  GM_registerMenuCommand('Sync lifestyle now', () => sync());
  GM_registerMenuCommand('Backfill lifestyle (90 days)', () => sync({ days: 90 }));
  GM_registerMenuCommand('Backfill lifestyle (365 days)', () => sync({ days: 365 }));
  GM_registerMenuCommand('Set form link', setFormLink);
  GM_registerMenuCommand('Show raw response for a date (console)', inspect);
  GM_registerMenuCommand('Reset lifestyle sync state', () => { GM_setValue('sent', {}); GM_setValue('lastSyncAt', 0); status('Sync state reset'); });

  (async function init() {
    for (let i = 0; i < 20 && !document.body; i++) await pause(500);
    mount();
    for (let i = 0; i < 20 && !csrfToken(); i++) await pause(500);
    const stale = Date.now() - GM_getValue('lastSyncAt', 0) > SETTINGS.autoSyncMinHours * 3600 * 1000;
    if (stale && GM_getValue('prefillUrl', '')) sync();
  })();
})();
