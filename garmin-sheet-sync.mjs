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

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

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

// Furthest back a normal sync reaches, however old the saved state is; --backfill can go further.
const MAX_CATCHUP_DAYS = 365;

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
  'overnight_hr',
];

// Whole-day totals that are still changing until the day ends.
const DAY_FIELDS = ['resting_hr', 'min_hr', 'max_hr', 'body_battery_high', 'body_battery_low', 'avg_stress', 'steps'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d = new Date()) => `${ymd(d)} ${d.toTimeString().slice(0, 8)}`;
const log = (...a) => console.log(stamp(), ...a);

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

// JSON.parse's own error quotes a few characters of the input, which could put part of a token
// or health data into a public Actions log. Replace it with a message that names only the source.
function parseJson(text, what) {
  try { return JSON.parse(text); } catch { throw new Error(`${what} returned invalid JSON`); }
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeJson(path, value) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

const IN_CI = process.env.GITHUB_ACTIONS === 'true';
const isLoopback = (u) => u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);

// The API key and health data must only ever go to Garmin and Google. Loopback is allowed for tests.
function checkGarminUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`GARMIN_BASE_URL is not a valid URL: ${raw}`); }
  const ok = (u.protocol === 'https:' && (u.hostname === 'garmin.com' || u.hostname.endsWith('.garmin.com'))) || isLoopback(u);
  if (!ok) throw new Error('GARMIN_BASE_URL must be an https://….garmin.com address; refusing to send the API key elsewhere.');
  return u.origin;
}

// config.json holds the API key, so warn (as ssh does) if other users can read or change it.
function warnIfConfigExposed() {
  if (process.platform === 'win32' || !existsSync(CONFIG_FILE)) return;
  const mode = statSync(CONFIG_FILE).mode & 0o777;
  if (mode & 0o077) {
    log(`Warning: ${CONFIG_FILE} is accessible to other users (mode ${mode.toString(8)}). Run: chmod 600 "${CONFIG_FILE}"`);
  }
}

function loadConfig() {
  // Under Actions, settings come only from the workflow's env, never from a file: the state
  // folder is restored from a cache, and a config file in it must not be able to redirect requests.
  if (!IN_CI) warnIfConfigExposed();
  const file = IN_CI ? {} : readJson(CONFIG_FILE, {});
  const { baseUrl: _ignoredBaseUrl, ...fileSettings } = file; // the base URL can only be overridden by env
  const cfg = {
    ...DEFAULTS,
    ...fileSettings,
    apiKey: process.env.GARMIN_API_KEY || file.apiKey,
    prefillUrl: process.env.PREFILL_URL || file.prefillUrl,
    baseUrl: checkGarminUrl(process.env.GARMIN_BASE_URL || DEFAULTS.baseUrl),
    firstRunDays: Number(process.env.FIRST_RUN_DAYS) || file.firstRunDays || DEFAULTS.firstRunDays,
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
      redirect: 'error', // never let a redirect carry the key off the checked host
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.text()).trim();
    if (res.status === 401 || res.status === 403) {
      throw new Error('Garmin rejected the API key: it is wrong, revoked or expired. Create a new one at https://connect.garmin.com/app/settings/personalApiToken');
    }
    if (!res.ok) throw new Error(`Token exchange failed (${res.status})`); // body omitted: it may echo credentials
    // The endpoint returns the bearer token as the response body.
    if (body.startsWith('{')) {
      const json = parseJson(body, 'Token exchange');
      this.token = json.access_token || json.accessToken;
    } else {
      this.token = body;
    }
    if (!this.token) throw new Error('Token exchange returned no token');
  }

  async get(path, params, { retried = false } = {}) {
    if (!this.token) await this.exchange();
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
      redirect: 'error', // never let a redirect carry the token off the checked host
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) {
      this.token = null; // revoked or expired early: mint a new token once
      return this.get(path, params, { retried: true });
    }
    if (res.status === 204 || res.status === 404) return null;
    if (res.status === 429) throw new Error('Garmin rate limit hit (429). Wait a while and run again.');
    if (!res.ok) {
      // Response bodies are left out of errors under Actions, whose logs are public on a public repo.
      const detail = IN_CI ? '' : `: ${(await res.text()).slice(0, 200)}`;
      throw new Error(`${res.status} on ${path}${detail}`);
    }
    const text = await res.text();
    await pause(this.cfg.requestDelayMs);
    return text ? parseJson(text, path) : null;
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
      r.overnight_hr = overnightHr(s, v);
    }
  }
}

// Average heart rate while asleep: Garmin's own figure if present, else the mean of the sleep HR samples.
function overnightHr(s, v) {
  const direct = pick(v, 'avgHeartRate', 'averageHeartRate', 'avgSleepHeartRate', 'sleepAvgHeartRate')
    || pick(s, 'avgHeartRate', 'averageHeartRate', 'avgSleepHeartRate');
  if (direct !== '') return Math.round(direct);
  const samples = (s.sleepHeartRate || v.sleepHeartRate || [])
    .map((x) => (typeof x === 'number' ? x : x && x.value))
    .filter((x) => typeof x === 'number' && x > 0);
  return samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : '';
}

// Field names: v2 range summaries nest values (heartRate.restingValue); the per-day endpoint is flat.
function applyDaily(r, s) {
  r.resting_hr = pick(s, 'heartRate.restingValue', 'restingHeartRate');
  r.min_hr = pick(s, 'heartRate.minValue', 'minHeartRate');
  r.max_hr = pick(s, 'heartRate.maxValue', 'maxHeartRate');
  r.body_battery_high = pick(s, 'bodyBattery.maxValue', 'bodyBatteryHighestValue');
  r.body_battery_low = pick(s, 'bodyBattery.minValue', 'bodyBatteryLowestValue');
  r.avg_stress = pick(s, 'stress.avgLevel', 'averageStressLevel');
  if (typeof r.avg_stress === 'number' && r.avg_stress < 0) r.avg_stress = ''; // Garmin uses -1/-2 for "not enough data"
  r.steps = pick(s, 'movement.steps.value', 'totalSteps');
}

async function pullDailies(g, from, to, rows) {
  // One call per year of data; fall back to one call per day if the range endpoint returns nothing.
  let found = 0;
  for (const [a, b] of windows(from, to, MAX_DAYS.dailies)) {
    const data = await g.get('/usersummary-service/v2/dailysummaries', { startDate: a, endDate: b });
    for (const s of rowsOf(data, 'data', 'dailySummaries')) {
      const d = dateOf(s);
      if (!d) continue;
      const r = row(rows, d);
      applyDaily(r, s);
      if (DAY_FIELDS.some((f) => r[f] !== '' && r[f] !== undefined)) found++;
    }
  }
  if (found) return;
  log('Range endpoint gave no usable daily summaries; fetching day by day.');
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
  const google = u.protocol === 'https:' && u.hostname === 'docs.google.com' && u.pathname.startsWith('/forms/');
  if (!google && !isLoopback(u)) throw new Error('prefillUrl must be a https://docs.google.com/forms/… link; refusing to send your data elsewhere.');
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
    redirect: 'follow', // Google answers with its own pages; checked below
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

// The state file stores a keyed hash (HMAC-SHA-256) of each day's values, never the values. It's
// cached on GitHub when run from Actions, and health values have few possible combinations, so a
// plain hash could be reversed by trying them all. The key is the form's address, which is already
// secret (anyone with it can add rows) and stays the same when the pre-filled link is regenerated.
// Older state files stored a plain SHA-256 or the raw joined values. Those still count as a match,
// so upgrading resends nothing, and each matching day is rewritten in the new format.
const rawFingerprint = (r) => FIELDS.map((f) => r[f] ?? '').join('|');
const legacyFingerprint = (r) => createHash('sha256').update(rawFingerprint(r)).digest('hex').slice(0, 16);
const fingerprint = (key, r) => 'h1:' + createHmac('sha256', key).update(rawFingerprint(r)).digest('hex').slice(0, 32);
const matchesLegacy = (sent, r) => sent[r.date] === legacyFingerprint(r) || sent[r.date] === rawFingerprint(r);

// The state file is restored from a cache, so check its shape rather than trusting it.
function loadState() {
  const s = readJson(STATE_FILE, {});
  const sent = s && typeof s.sent === 'object' && s.sent !== null && !Array.isArray(s.sent) ? s.sent : {};
  let lastSyncedDate = s && typeof s.lastSyncedDate === 'string' ? s.lastSyncedDate : null;
  if (lastSyncedDate) {
    try { parseYmd(lastSyncedDate); } catch { log('Ignoring an invalid lastSyncedDate in the state file.'); lastSyncedDate = null; }
  }
  return { lastSyncedDate, sent };
}

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
  const state = loadState();
  const today = parseYmd(ymd(new Date()));
  let from = backfillDays
    ? addDays(today, -(backfillDays - 1))
    : state.lastSyncedDate
      ? addDays(parseYmd(state.lastSyncedDate), -cfg.overlapDays)
      : addDays(today, -(cfg.firstRunDays - 1));
  if (!backfillDays) {
    // A stale or tampered state file mustn't trigger years of requests, or skip recent days.
    const earliest = addDays(today, -(MAX_CATCHUP_DAYS - 1));
    if (from < earliest) {
      log(`Saved state is older than ${MAX_CATCHUP_DAYS} days; syncing only the last ${MAX_CATCHUP_DAYS}. Use --backfill to go further.`);
      from = earliest;
    }
    if (from > today) from = addDays(today, -cfg.overlapDays);
  }

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
  const key = form.action;
  // Days sent under an older state format: already in the Sheet, so just rewrite their record.
  let upgraded = 0;
  for (const r of rows) {
    if (state.sent[r.date] !== fingerprint(key, r) && matchesLegacy(state.sent, r)) {
      state.sent[r.date] = fingerprint(key, r);
      upgraded++;
    }
  }
  if (upgraded) writeJson(STATE_FILE, state);
  const todo = rows.filter((r) => state.sent[r.date] !== fingerprint(key, r));
  let n = 0;
  for (const r of todo) {
    await submitRow(form, r);
    state.sent[r.date] = fingerprint(key, r);
    writeJson(STATE_FILE, state); // save as we go so a failure mid-run doesn't resend
    n++;
    await pause(cfg.requestDelayMs);
  }
  state.lastSyncedDate = todayS;
  writeJson(STATE_FILE, state);
  log(`Synced: ${n} submitted, ${rows.length - n} unchanged.` + (upgraded ? ` Updated the state format for ${upgraded} days.` : ''));
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
  // Logs of a public repo's Actions runs are public, so never print health data there.
  if (IN_CI && (flag('--dry-run') || flag('--dump'))) {
    throw new Error('--dry-run and --dump print your health data, and Actions logs on a public repo are public. Run them on your own computer.');
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
