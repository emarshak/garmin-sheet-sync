// ==UserScript==
// @name         Garmin Connect → Google Sheet sync
// @namespace    evan.garmin.sheet.sync
// @version      2.1.0
// @description  Pulls daily HRV, heart rate, sleep, Body Battery, stress and training readiness from your signed-in Garmin Connect session and submits them to a Google Form linked to a Sheet.
// @match        https://connect.garmin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      docs.google.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIG — paste the form's pre-filled link (see setup notes) into PREFILL_URL.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    PREFILL_URL: 'PASTE_YOUR_PREFILLED_FORM_LINK_HERE', // docs.google.com/forms/d/e/.../viewform?usp=pp_url&entry...
    FIRST_RUN_DAYS: 90,               // backfill window on first sync
    OVERLAP_DAYS: 3,                  // re-pull recent days (Garmin revises them)
    AUTO_SYNC_MIN_HOURS: 6,           // auto-sync on page load if older than this
    REQUEST_DELAY_MS: 250,            // pause between Garmin calls and between form submissions
    DEBUG: true,                      // logs raw responses to DevTools console; set false once verified
  };

  // Form questions, in order. The pre-filled link maps each of these names to its entry ID.
  const FIELDS = [
    'date',
    'hrv_last_night', 'hrv_5min_high', 'hrv_weekly_avg', 'hrv_status',
    'hrv_baseline_low', 'hrv_baseline_high',
    'resting_hr', 'min_hr', 'max_hr',
    'sleep_score', 'sleep_hours', 'deep_hours', 'rem_hours',
    'body_battery_high', 'body_battery_low', 'avg_stress', 'steps',
    'readiness_score', 'readiness_level',
  ];

  const API = 'https://connect.garmin.com/gc-api';
  const WINDOW_DAYS = 28;             // Garmin rejects 29+ day ranges on range endpoints

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => CONFIG.DEBUG && console.log('[garmin-sync]', ...a);

  function ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function dateList(from, to) {
    const out = [];
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) out.push(ymd(d));
    return out;
  }
  function windows(from, to) {
    const out = [];
    let start = new Date(from);
    while (start <= to) {
      let end = addDays(start, WINDOW_DAYS - 1);
      if (end > to) end = new Date(to);
      out.push([ymd(start), ymd(end)]);
      start = addDays(end, 1);
    }
    return out;
  }
  // First non-null value among candidate keys (field names vary across Garmin responses)
  function pick(obj, ...keys) {
    if (!obj) return '';
    for (const k of keys) {
      const v = k.split('.').reduce((o, part) => (o == null ? undefined : o[part]), obj);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  }
  const hours = (sec) => (sec === '' || sec == null ? '' : Math.round((sec / 3600) * 100) / 100);

  function csrfToken() {
    const selectors = ['meta[name="csrf-token"]', 'meta[name="_csrf"]', 'meta[name="connect-csrf-token"]'];
    for (const s of selectors) {
      const m = document.querySelector(s);
      if (m && m.content) return m.content;
    }
    return null;
  }

  async function getJSON(path) {
    const headers = { Accept: 'application/json', 'nk': 'NT' };
    const tok = csrfToken();
    if (tok) headers['connect-csrf-token'] = tok;
    const res = await fetch(API + path, { credentials: 'include', headers });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`${res.status} on ${path}`);
    const json = await res.json();
    log(path, json);
    return json;
  }

  // ---------------------------------------------------------------------------
  // Data pulls
  // ---------------------------------------------------------------------------
  async function displayName() {
    const p = await getJSON('/userprofile-service/socialProfile');
    const name = pick(p, 'displayName', 'userName');
    if (!name) throw new Error('Could not read displayName — are you signed in?');
    return name;
  }

  async function pullHrv(from, to, rows) {
    for (const [a, b] of windows(from, to)) {
      try {
        const data = await getJSON(`/hrv-service/hrv/daily/${a}/${b}`);
        const list = (data && (data.hrvSummaries || data.hrvSummaryList)) || (Array.isArray(data) ? data : []);
        for (const h of list) {
          const r = row(rows, h.calendarDate);
          r.hrv_last_night = pick(h, 'lastNightAvg');
          r.hrv_5min_high = pick(h, 'lastNight5MinHigh');
          r.hrv_weekly_avg = pick(h, 'weeklyAvg');
          r.hrv_status = pick(h, 'status');
          r.hrv_baseline_low = pick(h, 'baseline.balancedLow');
          r.hrv_baseline_high = pick(h, 'baseline.balancedUpper');
        }
      } catch (e) { console.warn('[garmin-sync] HRV', a, b, e.message); }
    }
  }

  async function pullSleep(from, to, rows) {
    for (const [a, b] of windows(from, to)) {
      try {
        const data = await getJSON(`/sleep-service/stats/sleep/daily/${a}/${b}`);
        const list = (data && (data.individualStats || data.dailySleepStats)) || (Array.isArray(data) ? data : []);
        for (const s of list) {
          const v = s.values || s;
          const r = row(rows, s.calendarDate);
          r.sleep_score = pick(v, 'sleepScore', 'overallSleepScore', 'sleepScores.overall.value');
          r.sleep_hours = hours(pick(v, 'totalSleepTimeInSeconds', 'sleepTimeInSeconds'));
          r.deep_hours = hours(pick(v, 'deepTime', 'deepSleepSeconds'));
          r.rem_hours = hours(pick(v, 'remTime', 'remSleepSeconds'));
        }
      } catch (e) { console.warn('[garmin-sync] Sleep', a, b, e.message); }
    }
  }

  async function pullDaily(name, dates, rows, status) {
    let i = 0;
    for (const date of dates) {
      i++;
      status(`Daily summaries ${i}/${dates.length}…`);
      try {
        const s = await getJSON(`/usersummary-service/usersummary/daily/${encodeURIComponent(name)}?calendarDate=${date}`);
        if (s) {
          const r = row(rows, date);
          r.resting_hr = pick(s, 'restingHeartRate');
          r.min_hr = pick(s, 'minHeartRate');
          r.max_hr = pick(s, 'maxHeartRate');
          r.body_battery_high = pick(s, 'bodyBatteryHighestValue');
          r.body_battery_low = pick(s, 'bodyBatteryLowestValue');
          r.avg_stress = pick(s, 'averageStressLevel');
          r.steps = pick(s, 'totalSteps');
        }
      } catch (e) { console.warn('[garmin-sync] Summary', date, e.message); }

      try {
        const t = await getJSON(`/metrics-service/metrics/trainingreadiness/${date}`);
        // Garmin recalculates readiness several times a day; prefer the morning (on-wake) value.
        const list = Array.isArray(t) ? t : [t];
        const first = list.find((x) => x && /WAKEUP/i.test(x.inputContext || '')) || list[0];
        if (first) {
          const r = row(rows, date);
          r.readiness_score = pick(first, 'score');
          r.readiness_level = pick(first, 'level');
        }
      } catch (e) { log('Readiness', date, e.message); } // not all devices support it

      await pause(CONFIG.REQUEST_DELAY_MS);
    }
  }

  function row(rows, date) {
    if (!rows[date]) rows[date] = { date };
    return rows[date];
  }

  // ---------------------------------------------------------------------------
  // Push to Google Form (→ linked Sheet)
  // ---------------------------------------------------------------------------
  function formSetup() {
    let u;
    try { u = new URL(CONFIG.PREFILL_URL); } catch { throw new Error('PREFILL_URL is not a valid link'); }
    if (!/\/viewform$/.test(u.pathname)) throw new Error('PREFILL_URL should be the pre-filled link ending in /viewform?…');
    const action = u.origin + u.pathname.replace(/\/viewform$/, '/formResponse');
    const map = {};
    for (const [k, v] of u.searchParams) if (k.startsWith('entry.')) map[v.trim()] = k;
    if (!map.date) throw new Error('Pre-filled link has no "date" field — type each question\'s name as its answer.');
    const missing = FIELDS.filter((f) => !map[f]);
    if (missing.length) console.warn('[garmin-sync] Not in form, will be skipped:', missing.join(', '));
    return { action, map };
  }

  function submitRow(form, rowObj) {
    const body = new URLSearchParams();
    for (const f of FIELDS) {
      const v = rowObj[f];
      if (form.map[f] && v !== undefined && v !== null && v !== '') body.append(form.map[f], String(v));
    }
    body.append('fvv', '1');
    body.append('pageHistory', '0');
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: form.action,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: body.toString(),
        anonymous: true, // don't send your Google cookies; the form should accept anonymous responses
        onload: (r) => {
          const html = r.responseText || '';
          const finalUrl = r.finalUrl || '';
          // Google returns 200 for rejected submissions too, so look for the actual confirmation page.
          const confirmed = /freebirdFormviewerViewResponseConfirmationMessage|response has been recorded/i.test(html);
          if (r.status === 200 && confirmed && !/accounts\.google\.com/.test(finalUrl)) return resolve();
          const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
          console.warn('[garmin-sync] Form rejected submission', { status: r.status, finalUrl, title, sent: body.toString() });
          let hint = 'see console for details';
          if (/accounts\.google\.com|ServiceLogin|signin/i.test(finalUrl + html.slice(0, 5000))) hint = 'form requires sign-in: turn off email collection and "Limit to 1 response"';
          else if (/closedform|no longer accepting/i.test(finalUrl + html)) hint = 'form is not accepting responses or is not published';
          else if (r.status === 404 || /unavailable|not found/i.test(title)) hint = 'form URL not found: use the published responder link (…/forms/d/e/…/viewform), not the editor link';
          else if (r.status === 400) hint = 'Google rejected the answers (a question may have validation, or the entry IDs are wrong)';
          reject(new Error(`Form rejected (${r.status}): ${hint}`));
        },
        onerror: () => reject(new Error('Network error submitting to Google Form')),
      });
    });
  }

  // Only send a day if it's new or its values changed since the last submission.
  const fingerprint = (r) => FIELDS.map((f) => (r[f] ?? '')).join('|');

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------
  let running = false;

  async function sync({ fullDays } = {}) {
    if (running) return;
    if (CONFIG.PREFILL_URL.startsWith('PASTE')) return status('Set PREFILL_URL in the script first.', true);
    running = true;
    try {
      const form = formSetup();
      const today = parseYmd(ymd(new Date()));
      const last = GM_getValue('lastSyncedDate', null);
      const from = fullDays
        ? addDays(today, -(fullDays - 1))
        : last
          ? addDays(parseYmd(last), -CONFIG.OVERLAP_DAYS)
          : addDays(today, -(CONFIG.FIRST_RUN_DAYS - 1));

      status(`Syncing ${ymd(from)} → ${ymd(today)}…`);
      const name = await displayName();
      const rows = {};
      status('Pulling HRV…');
      await pullHrv(from, today, rows);
      status('Pulling sleep…');
      await pullSleep(from, today, rows);
      await pullDaily(name, dateList(from, today), rows, status);

      const rowList = Object.values(rows).sort((a, b) => a.date.localeCompare(b.date));
      if (!rowList.length) throw new Error('No data returned — check DevTools console.');
      const sent = GM_getValue('sentFingerprints', {});
      const todo = rowList.filter((r) => sent[r.date] !== fingerprint(r));
      let n = 0;
      for (const r of todo) {
        n++;
        status(`Submitting ${n}/${todo.length} to Sheet…`);
        await submitRow(form, r);
        sent[r.date] = fingerprint(r);
        GM_setValue('sentFingerprints', sent); // save as we go so a failure mid-run doesn't resend
        await pause(CONFIG.REQUEST_DELAY_MS);
      }

      GM_setValue('lastSyncedDate', ymd(today));
      GM_setValue('lastSyncAt', Date.now());
      status(`✓ Synced: ${todo.length} sent, ${rowList.length - todo.length} unchanged`);
    } catch (e) {
      console.error('[garmin-sync]', e);
      status(`✗ ${e.message}`, true);
    } finally {
      running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // UI: small floating button
  // ---------------------------------------------------------------------------
  let label;
  function status(msg, isErr) {
    if (label) {
      label.textContent = msg;
      label.style.color = isErr ? '#ffb4b4' : '#fff';
    }
    log(msg);
  }

  function mountButton() {
    if (document.getElementById('gsync-box')) return;
    const box = document.createElement('div');
    box.id = 'gsync-box';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#1f2937;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center;max-width:320px';
    const btn = document.createElement('button');
    btn.textContent = 'Sync → Sheet';
    btn.style.cssText = 'background:#2563eb;color:#fff;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit';
    btn.onclick = () => sync();
    label = document.createElement('span');
    const last = GM_getValue('lastSyncedDate', null);
    label.textContent = last ? `Last synced through ${last}` : 'Not synced yet';
    box.append(btn, label);
    document.body.appendChild(box);
  }

  GM_registerMenuCommand('Sync now', () => sync());
  GM_registerMenuCommand(`Full backfill (${CONFIG.FIRST_RUN_DAYS} days)`, () => sync({ fullDays: CONFIG.FIRST_RUN_DAYS }));
  GM_registerMenuCommand('Full backfill (365 days)', () => sync({ fullDays: 365 }));
  GM_registerMenuCommand('Reset sync state (resends everything)', () => {
    GM_setValue('lastSyncedDate', null);
    GM_setValue('lastSyncAt', 0);
    GM_setValue('sentFingerprints', {});
    status('Sync state reset');
  });

  // Wait for the signed-in app to load, then show the button and auto-sync if stale.
  (async function init() {
    for (let i = 0; i < 20 && !document.body; i++) await pause(500);
    mountButton();
    for (let i = 0; i < 20 && !csrfToken(); i++) await pause(500);
    if (!csrfToken()) log('No CSRF meta tag found; will try requests without it.');
    const lastAt = GM_getValue('lastSyncAt', 0);
    if (Date.now() - lastAt > CONFIG.AUTO_SYNC_MIN_HOURS * 3600 * 1000) sync();
  })();
})();
