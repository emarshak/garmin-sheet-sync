// Mock-server tests for garmin-sheet-sync.mjs. Synthetic data only; everything on loopback.
// Usage: node test/run-tests.mjs   (or pass another script path as the first argument)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SCRIPT = process.argv[2] || fileURLToPath(new URL('../garmin-sheet-sync.mjs', import.meta.url));
const SECRET_TOKEN = 'SECRETTOKENZZZ999';
const API_KEY = 'TESTAPIKEY000';

let mode = 'normal';
let hits = { hrv: 0, sleep: 0, dailies: 0, form: 0, token: 0 };
let otherHostGotAuth = null;

const ymdRange = (a, b) => {
  const out = [];
  for (let d = new Date(a + 'T00:00:00'); d <= new Date(b + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    const p = (n) => String(n).padStart(2, '0');
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return out;
};

function listen(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });
}

const other = await listen((req, res) => { otherHostGotAuth = req.headers.authorization || ''; res.end('{}'); });
const otherPort = other.address().port;

const garmin = await listen((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.endsWith('/token')) {
    hits.token++;
    if (mode === 'badTokenJson') return res.end(`{"x":1,"access_token":${SECRET_TOKEN}}`);
    if (mode === 'redirectToken') { res.writeHead(307, { Location: `http://127.0.0.1:${otherPort}/steal` }); return res.end(); }
    return res.end(SECRET_TOKEN);
  }
  if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) { res.writeHead(401); return res.end(); }
  if (mode === 'redirectData') { res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/steal` }); return res.end(); }
  if (mode === 'badDataJson') return res.end('{"lastNightAvg":HEALTHVALUE77}');
  let m;
  if ((m = u.pathname.match(/hrv\/daily\/([\d-]+)\/([\d-]+)/))) {
    hits.hrv++;
    return res.end(JSON.stringify({ hrvSummaries: ymdRange(m[1], m[2]).map((d) => ({ calendarDate: d, lastNightAvg: 41, weeklyAvg: 43, status: 'BALANCED' })) }));
  }
  if (u.pathname.includes('dailySleepSummariesByDate')) {
    hits.sleep++;
    return res.end(JSON.stringify({ dailySleepSummaries: ymdRange(u.searchParams.get('startDate'), u.searchParams.get('endDate')).map((d) => ({ calendarDate: d, sleepTimeSeconds: 27000 })) }));
  }
  if (u.pathname.includes('v2/dailysummaries')) {
    hits.dailies++;
    return res.end(JSON.stringify(ymdRange(u.searchParams.get('startDate'), u.searchParams.get('endDate')).map((d) => ({ calendarDate: d, restingHeartRate: 52, totalSteps: 9000 }))));
  }
  res.writeHead(404); res.end();
});
const gPort = garmin.address().port;

const form = await listen((req, res) => { hits.form++; req.resume(); req.on('end', () => res.end('<div>Your response has been recorded.</div>')); });
const fPort = form.address().port;
const PREFILL = `http://127.0.0.1:${fPort}/forms/d/e/TESTFORM/viewform?usp=pp_url&entry.1=date&entry.2=hrv_last_night&entry.3=hrv_weekly_avg&entry.4=hrv_status&entry.5=sleep_hours&entry.6=resting_hr&entry.7=steps`;

// Runs the script against the mock servers. ci=true mimics GitHub Actions (settings from env only).
function exec(args, { dir, ci = true, env: extra = {} } = {}) {
  hits = { hrv: 0, sleep: 0, dailies: 0, form: 0, token: 0 };
  otherHostGotAuth = null;
  const base = { PATH: process.env.PATH, HOME: dir, TZ: 'America/New_York', GARMIN_SHEET_SYNC_DIR: dir, GARMIN_BASE_URL: `http://127.0.0.1:${gPort}` };
  const env = ci ? { ...base, GITHUB_ACTIONS: 'true', GARMIN_API_KEY: API_KEY, PREFILL_URL: PREFILL, FIRST_RUN_DAYS: '3', ...extra } : { ...base, ...extra };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`); if (!cond) failed++; };
const fresh = () => mkdtempSync(join(tmpdir(), 'gss-'));
const state = (dir) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));

// 1. Normal first sync: state uses keyed hashes, contains no values.
{
  const dir = fresh();
  const r = await exec([], { dir });
  const s = state(dir);
  const vals = Object.values(s.sent);
  check('first sync succeeds', r.code === 0 && /Synced: 3 submitted/.test(r.out), r.out);
  check('state entries are HMAC (h1:)', vals.length === 3 && vals.every((v) => /^h1:[0-9a-f]{32}$/.test(v)), JSON.stringify(s));
  check('state holds no health values', !/41|9000|27000|BALANCED/.test(JSON.stringify(s)));
  check('CI output has no token or values', !r.out.includes(SECRET_TOKEN) && !/BALANCED|9000/.test(r.out), r.out);
  const r2 = await exec([], { dir });
  check('second sync resends no already-sent day (only the one new overlap day)', /Synced: 1 submitted, 3 unchanged/.test(r2.out) && hits.form === 1, r2.out);

}

// 2. Legacy state (plain SHA-256 and raw values) upgrades without resending.
{
  const dir = fresh();
  await exec([], { dir }); // learn current rows
  const rows = Object.keys(state(dir).sent).sort();
  // Rebuild what the old script would have stored, using its exact field order.
  const FIELDS = ['date','hrv_last_night','hrv_5min_high','hrv_weekly_avg','hrv_status','hrv_baseline_low','hrv_baseline_high','resting_hr','min_hr','max_hr','sleep_score','sleep_hours','deep_hours','rem_hours','body_battery_high','body_battery_low','avg_stress','steps','readiness_score','readiness_level','overnight_hr'];
  const todayS = rows.at(-1);
  const rowFor = (d) => {
    const r = { date: d, hrv_last_night: 41, hrv_5min_high: '', hrv_weekly_avg: 43, hrv_status: 'BALANCED', hrv_baseline_low: '', hrv_baseline_high: '', sleep_score: '', sleep_hours: 7.5, deep_hours: '', rem_hours: '', overnight_hr: '' };
    if (d !== todayS) Object.assign(r, { resting_hr: 52, min_hr: '', max_hr: '', body_battery_high: '', body_battery_low: '', avg_stress: '', steps: 9000 });
    return r;
  };
  const raw = (r) => FIELDS.map((f) => r[f] ?? '').join('|');
  const legacy = {};
  rows.forEach((d, i) => { legacy[d] = i % 2 ? raw(rowFor(d)) : createHash('sha256').update(raw(rowFor(d))).digest('hex').slice(0, 16); });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastSyncedDate: todayS, sent: legacy }));
  const r = await exec([], { dir });
  check('legacy state: no legacy day resent', hits.form === 1 && /Synced: 1 submitted, 3 unchanged/.test(r.out), r.out);
  check('legacy state: entries rewritten as h1', Object.values(state(dir).sent).every((v) => v.startsWith('h1:')) && /Updated the state format for 3 days/.test(r.out), JSON.stringify(state(dir)) + r.out);
}

// 3. Malformed JSON never echoes the token or data into CI output.
{
  mode = 'badTokenJson';
  const r = await exec([], { dir: fresh() });
  check('bad token JSON: fails generically, no token in output', r.code === 1 && /Token exchange returned invalid JSON/.test(r.out) && !r.out.includes('SECRETTOK'), r.out);
  mode = 'badDataJson';
  const r2 = await exec([], { dir: fresh() });
  check('bad data JSON: fails generically, no value in output', r2.code === 1 && /returned invalid JSON/.test(r2.out) && !r2.out.includes('HEALTHVAL'), r2.out);
}

// 4. Redirects off the Garmin host are refused; credentials never reach the other host.
{
  mode = 'redirectToken';
  const r = await exec([], { dir: fresh() });
  check('token redirect refused, key not forwarded', r.code === 1 && otherHostGotAuth === null, `auth=${otherHostGotAuth} ${r.out}`);
  mode = 'redirectData';
  const r2 = await exec([], { dir: fresh() });
  check('data redirect refused, token not forwarded', r2.code === 1 && otherHostGotAuth === null, `auth=${otherHostGotAuth} ${r2.out}`);
  mode = 'normal';
}

// 5. Hostile or corrupt state is bounded and doesn't crash.
{
  const dir = fresh();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastSyncedDate: '1990-01-01', sent: {} }));
  const r = await exec(['--dry-run'], { dir, ci: false, env: { GARMIN_API_KEY: API_KEY, PREFILL_URL: PREFILL } });
  check('ancient lastSyncedDate clamped to 365 days', /older than 365 days/.test(r.out) && hits.hrv === 14 && /Dry run: 365 days/.test(r.out), `hrv=${hits.hrv} ${r.out.slice(-300)}`);

  for (const bad of [{ lastSyncedDate: 'garbage', sent: null }, { sent: [] }, { lastSyncedDate: 12345 }, 'not an object', { lastSyncedDate: '2999-01-01', sent: {} }]) {
    const d = fresh();
    writeFileSync(join(d, 'state.json'), JSON.stringify(bad));
    const rr = await exec([], { dir: d });
    check(`bad state ${JSON.stringify(bad)} handled`, rr.code === 0 && /Synced:/.test(rr.out), rr.out);
  }
}

// 6. Loose config.json permissions trigger a warning locally (never read under CI).
{
  const dir = fresh();
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ apiKey: API_KEY, prefillUrl: PREFILL }));
  chmodSync(cfg, 0o644);
  const r = await exec(['--check'], { dir, ci: false });
  check('mode 644 config warns', r.code === 0 && /accessible to other users \(mode 644\)/.test(r.out) && !r.out.includes(API_KEY), r.out);
  chmodSync(cfg, 0o600);
  const r2 = await exec(['--check'], { dir, ci: false });
  check('mode 600 config does not warn', r2.code === 0 && !/accessible to other users/.test(r2.out), r2.out);
}

// 7. Existing CI guards still hold.
{
  const r = await exec(['--dump', '2026-11-01'], { dir: fresh() });
  check('--dump still refused under CI', r.code === 1 && /Actions logs/.test(r.out), r.out);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
garmin.close(); form.close(); other.close();
process.exit(failed ? 1 : 0);
