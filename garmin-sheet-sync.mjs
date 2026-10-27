#!/usr/bin/env node
// Garmin Connect → Google Sheet sync, using Garmin's official Personal API.
//
// Reads daily HRV, heart rate, sleep, Body Battery, stress and steps for your own
// account and submits one row per day to a Google Form that is linked to a Sheet.
// Requires Node 18+ and no npm packages.
//
// Usage:
//   node garmin-sheet-sync.mjs                 sync new and recently revised days
//   node garmin-sheet-sync.mjs --backfill 365  re-pull the last N days
//   node garmin-sheet-sync.mjs --dry-run       print rows instead of submitting
//   node garmin-sheet-sync.mjs --dump 2026-10-20  print Garmin's raw responses for one day
//   node garmin-sheet-sync.mjs --check         verify the API key and form link
//   node garmin-sheet-sync.mjs --reset         forget which days were already sent

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const CONFIG_DIR = process.env.GARMIN_SHEET_SYNC_DIR || join(homedir(), '.config', 'garmin-sheet-sync');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const STATE_FILE = join(CONFIG_DIR, 'state.json');

const DEFAULTS = {
  firstRunDays: 90,      // backfill window on the first sync
  overlapDays: 3,        // re-pull recent days; Garmin revises them
  requestDelayMs: 250,   // pause between Garmin calls and between form submissions
  baseUrl: 'https://personal.connectapi.garmin.com',
};

const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const TIMEOUT_MS = 30_000;

// Per-request range limits from Garmin's Personal API docs (HRV is undocumented; kept conservative).
const MAX_DAYS = { hrv: 28, sleep: 31, dailies: 365 };

// Form questions, in order. Readiness columns stay in the form for older rows,
// but the Personal API doesn't provide training readiness, so they're left blank.
const FIELDS = [
  'date',
  'hrv_last_night', 'hrv_5min_high', 'hrv_weekly_avg', 'hrv_status',
  'hrv_baseline_low', 'hrv_baseline_high',
  'resting_hr', 'min_hr', 'max_hr',
  'sleep_score', 'sleep_hours', 'deep_hours', 'rem_hours',
  'body_battery_high', 'body_battery_low', 'avg_stress', 'steps',
  'readiness_score', 'readiness_level',
];

// Whole-day totals that are still changing until the day ends.
const DAY_FIELDS = ['resting_hr', 'min_hr', 'max_hr', 'body_battery_high', 'body_battery_low', 'avg_stress', 'steps'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) throw new Error(`Expected a date like 2026-10-20, got "${s}"`);
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function windows(from, to, maxDays) {
  const out = [];
  for (let start = new Date(from); start <= to;) {
    let end = addDays(start, maxDays - 1);
    if (end > to) end = new Date(to);
    out.push([ymd(start), ymd(end)]);
    start = addDays(end, 1);
  }
  return out;
}
// First non-empty value among candidate keys; dotted keys walk nested objects.
function pick(obj, ...keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? undefined : o[part]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}
const hours = (sec) => (sec === '' || sec == null ? '' : Math.round((sec / 3600) * 100) / 100);
// Garmin wraps lists differently per endpoint; find the array of day records.
function rowsOf(data, ...keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  const firstArray = Object.values(data).find(Array.isArray);
  return firstArray || [data];
}
const dateOf = (r) => String(pick(r, 'calendarDate', 'dailySleepDTO.calendarDate', 'summaryDate', 'date')).slice(0, 10);

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeJson(path, value) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function loadConfig() {
  const file = readJson(CONFIG_FILE, {});
  const cfg = {
    ...DEFAULTS,
    ...file,
    apiKey: process.env.GARMIN_API_KEY || file.apiKey,
    prefillUrl: process.env.PREFILL_URL || file.prefillUrl,
    baseUrl: (process.env.GARMIN_BASE_URL || file.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
  };
  const missing = [];
  if (!cfg.apiKey) missing.push('apiKey');
  if (!cfg.prefillUrl) missing.push('prefillUrl');
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(' and ')}. Put them in ${CONFIG_FILE}:\n` +
      `  { "apiKey": "…", "prefillUrl": "https://docs.google.com/forms/d/e/…/viewform?usp=pp_url&entry.…" }`);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Garmin Personal API
// ---------------------------------------------------------------------------
class Garmin {
  constructor(cfg) {
    this.cfg = cfg;
    this.token = null;
  }

  async exchange() {
    const res = await fetch(this.cfg.baseUrl + TOKEN_PATH, {
      method: 'POST',
      headers: { Accept: '*/*', Authorization: `ApiKey ${this.cfg.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.text()).trim();
    if (res.status === 401 || res.status === 403) {
      throw new Error('Garmin rejected the API key: it is wrong, revoked or expired. Create a new one at https://connect.garmin.com/app/settings/personalApiToken');
    }
    if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${body.slice(0, 200)}`);
    // The endpoint returns the bearer token as the response body.
    this.token = body.startsWith('{') ? (JSON.parse(body).access_token || JSON.parse(body).accessToken) : body;
    if (!this.token) throw new Error('Token exchange returned no token');
  }

  async get(path, params, { retried = false } = {}) {
    if (!this.token) await this.exchange();
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) {
      this.token = null; // revoked or expired early: mint a new token once
      return this.get(path, params, { retried: true });
    }
    if (res.status === 204 || res.status === 404) return null;
    if (res.status === 429) throw new Error('Garmin rate limit hit (429). Wait a while and run again.');
    if (!res.ok) throw new Error(`${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    await pause(this.cfg.requestDelayMs);
    return text ? JSON.parse(text) : null;
  }
}

// ---------------------------------------------------------------------------
// Data pulls → one object per date
// ---------------------------------------------------------------------------
function row(rows, date) {
  if (!date) return {};
  if (!rows[date]) rows[date] = { date };
  return rows[date];
}

async function pullHrv(g, from, to, rows) {
  for (const [a, b] of windows(from, to, MAX_DAYS.hrv)) {
    const data = await g.get(`/hrv-service/hrv/daily/${a}/${b}`);
    for (const h of rowsOf(data, 'hrvSummaries', 'hrvSummaryList')) {
      const r = row(rows, dateOf(h));
      r.hrv_last_night = pick(h, 'lastNightAvg');
      r.hrv_5min_high = pick(h, 'lastNight5MinHigh');
      r.hrv_weekly_avg = pick(h, 'weeklyAvg');
      r.hrv_status = pick(h, 'status');
      r.hrv_baseline_low = pick(h, 'baseline.balancedLow');
      r.hrv_baseline_high = pick(h, 'baseline.balancedUpper');
    }
  }
}

async function pullSleep(g, from, to, rows) {
  for (const [a, b] of windows(from, to, MAX_DAYS.sleep)) {
    const data = await g.get('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: a, endDate: b });
    for (const s of rowsOf(data, 'dailySleepSummaries', 'sleepSummaries', 'individualStats')) {
      const v = s.dailySleepDTO || s.values || s;
      const r = row(rows, dateOf(s) || dateOf(v));
      r.sleep_score = pick(v, 'sleepScores.overall.value', 'overallSleepScore', 'sleepScore');
      r.sleep_hours = hours(pick(v, 'sleepTimeSeconds', 'totalSleepTimeInSeconds', 'sleepTimeInSeconds'));
      r.deep_hours = hours(pick(v, 'deepSleepSeconds', 'deepSleepDurationInSeconds', 'deepTime'));
      r.rem_hours = hours(pick(v, 'remSleepSeconds', 'remSleepInSeconds', 'remTime'));
    }
  }
}

function applyDaily(r, s) {
  r.resting_hr = pick(s, 'restingHeartRate', 'restingHeartRateInBeatsPerMinute');
  r.min_hr = pick(s, 'minHeartRate', 'minHeartRateInBeatsPerMinute');
  r.max_hr = pick(s, 'maxHeartRate', 'maxHeartRateInBeatsPerMinute');
  r.body_battery_high = pick(s, 'bodyBatteryHighestValue', 'bodyBattery.highest');
  r.body_battery_low = pick(s, 'bodyBatteryLowestValue', 'bodyBattery.lowest');
  r.avg_stress = pick(s, 'averageStressLevel', 'stress.averageStressLevel');
  r.steps = pick(s, 'totalSteps', 'steps');
}

async function pullDailies(g, from, to, rows) {
  // One call per year of data; fall back to one call per day if the range endpoint returns nothing.
  let found = 0;
  for (const [a, b] of windows(from, to, MAX_DAYS.dailies)) {
    const data = await g.get('/usersummary-service/v2/dailysummaries', { startDate: a, endDate: b });
    for (const s of rowsOf(data, 'data', 'dailySummaries')) {
      const d = dateOf(s);
      if (!d) continue;
      applyDaily(row(rows, d), s);
      found++;
    }
  }
  if (found) return;
  log('Range endpoint returned no daily summaries; fetching day by day.');
  for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
    const s = await g.get('/usersummary-service/usersummary/daily', { calendarDate: ymd(d) });
    if (s) applyDaily(row(rows, ymd(d)), s);
  }
}

// ---------------------------------------------------------------------------
// Google Form
// ---------------------------------------------------------------------------
function formSetup(prefillUrl) {
  let u;
  try { u = new URL(prefillUrl); } catch { throw new Error('prefillUrl is not a valid link'); }
  if (!/\/viewform$/.test(u.pathname)) throw new Error('prefillUrl should be the pre-filled link ending in /viewform?…');
  const action = u.origin + u.pathname.replace(/\/viewform$/, '/formResponse');
  const map = {};
  for (const [k, v] of u.searchParams) if (k.startsWith('entry.')) map[v.trim()] = k;
  if (!map.date) throw new Error('Pre-filled link has no "date" field. Type each question\'s name as its answer when creating the link.');
  const missing = FIELDS.filter((f) => !map[f] && !f.startsWith('readiness_'));
  if (missing.length) log('Not in the form, will be skipped:', missing.join(', '));
  return { action, map };
}

async function submitRow(form, r) {
  const body = new URLSearchParams();
  for (const f of FIELDS) {
    const v = r[f];
    if (form.map[f] && v !== undefined && v !== null && v !== '') body.append(form.map[f], String(v));
  }
  body.append('fvv', '1');
  body.append('pageHistory', '0');
  const res = await fetch(form.action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const html = await res.text();
  // Google answers 200 even when it rejects a response, so check for the confirmation page.
  if (res.ok && /freebirdFormviewerViewResponseConfirmationMessage|response has been recorded/i.test(html)
      && !/accounts\.google\.com/.test(res.url)) return;
  let hint = 'unexpected response';
  if (/accounts\.google\.com|ServiceLogin/i.test(res.url + html.slice(0, 5000))) hint = 'the form requires sign-in: turn off email collection and "Limit to 1 response"';
  else if (/closedform|no longer accepting/i.test(res.url + html)) hint = 'the form is not published or not accepting responses';
  else if (res.status === 404) hint = 'form not found: use the published responder link (…/forms/d/e/…/viewform)';
  else if (res.status === 400) hint = 'Google rejected the answers (check question validation and the pre-filled link)';
  throw new Error(`Form rejected ${r.date} (${res.status}): ${hint}`);
}

const fingerprint = (r) => FIELDS.map((f) => r[f] ?? '').join('|');

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function collect(g, from, to) {
  const rows = {};
  log(`Pulling ${ymd(from)} → ${ymd(to)}`);
  await pullHrv(g, from, to, rows);
  await pullSleep(g, from, to, rows);
  await pullDailies(g, from, to, rows);
  const fromS = ymd(from), toS = ymd(to);
  return Object.values(rows)
    .filter((r) => r.date >= fromS && r.date <= toS && FIELDS.some((f) => f !== 'date' && r[f] !== '' && r[f] !== undefined))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function sync(cfg, { backfillDays, dryRun }) {
  const form = formSetup(cfg.prefillUrl);
  const g = new Garmin(cfg);
  const state = readJson(STATE_FILE, { lastSyncedDate: null, sent: {} });
  const today = parseYmd(ymd(new Date()));
  const from = backfillDays
    ? addDays(today, -(backfillDays - 1))
    : state.lastSyncedDate
      ? addDays(parseYmd(state.lastSyncedDate), -cfg.overlapDays)
      : addDays(today, -(cfg.firstRunDays - 1));

  // Garmin files last night's sleep and HRV under today's date, and those are final by
  // morning. Today's totals (steps, stress, Body Battery, heart rate) keep changing until
  // midnight, and a form can only append, so they're held back: today's row carries only
  // the overnight fields, and the full row follows on the first run after the day ends.
  const todayS = ymd(today);
  const rows = (await collect(g, from, today))
    .map((r) => (r.date === todayS ? Object.fromEntries(Object.entries(r).filter(([k]) => !DAY_FIELDS.includes(k))) : r))
    .filter((r) => FIELDS.some((f) => f !== 'date' && r[f] !== '' && r[f] !== undefined));
  if (dryRun) {
    console.table(rows);
    log(`Dry run: ${rows.length} days, nothing submitted.`);
    return;
  }
  const todo = rows.filter((r) => state.sent[r.date] !== fingerprint(r));
  let n = 0;
  for (const r of todo) {
    await submitRow(form, r);
    state.sent[r.date] = fingerprint(r);
    writeJson(STATE_FILE, state); // save as we go so a failure mid-run doesn't resend
    n++;
    await pause(cfg.requestDelayMs);
  }
  state.lastSyncedDate = todayS;
  writeJson(STATE_FILE, state);
  log(`Synced: ${n} submitted, ${rows.length - n} unchanged.`);
}

async function dump(cfg, date) {
  const g = new Garmin(cfg);
  const d = parseYmd(date);
  const calls = [
    ['/hrv-service/hrv/daily/' + date + '/' + date],
    ['/sleep-service/sleep/dailySleepSummariesByDate', { startDate: date, endDate: date }],
    ['/usersummary-service/v2/dailysummaries', { startDate: date, endDate: date }],
    ['/usersummary-service/usersummary/daily', { calendarDate: date }],
  ];
  for (const [path, params] of calls) {
    console.log(`\n=== GET ${path}${params ? '?' + new URLSearchParams(params) : ''}`);
    try { console.log(JSON.stringify(await g.get(path, params), null, 2)); } catch (e) { console.log('ERROR', e.message); }
  }
  console.log('\n=== Parsed row');
  console.log(JSON.stringify(await collect(g, d, d), null, 2));
}

async function check(cfg) {
  formSetup(cfg.prefillUrl);
  log('Form link OK.');
  const g = new Garmin(cfg);
  await g.exchange();
  log('Garmin API key OK.');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

  if (flag('--help') || flag('-h')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  if (flag('--reset')) {
    if (existsSync(STATE_FILE)) writeJson(STATE_FILE, { lastSyncedDate: null, sent: {} });
    log('Sync state reset; the next run resends everything in its window.');
    return;
  }
  const cfg = loadConfig();
  if (flag('--check')) return check(cfg);
  if (flag('--dump')) return dump(cfg, value('--dump') || ymd(new Date()));
  const backfill = value('--backfill');
  if (backfill !== undefined && !(Number(backfill) > 0)) throw new Error('--backfill needs a number of days, e.g. --backfill 365');
  return sync(cfg, { backfillDays: backfill ? Number(backfill) : 0, dryRun: flag('--dry-run') });
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
