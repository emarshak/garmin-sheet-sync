# Garmin Connect → Google Sheet sync

A small Node script that copies your daily Garmin health metrics into a Google Sheet, one row per day: HRV, resting heart rate, sleep, Body Battery, stress and steps.

It uses Garmin's official **Personal API**, a free, read-only API for your own data. Rows go to a Google Form that is linked to a Sheet, so no Google Apps Script or OAuth is needed. That also works on Google accounts with Advanced Protection, which block Apps Script web apps. It runs on a schedule either on **GitHub Actions** (no computer needed) or on your Mac with launchd, every 2 hours.

> The earlier Tampermonkey userscript, which read Garmin's unofficial web endpoints, is in [`deprecated/`](deprecated/).

## How it works

1. The script trades your Personal API key for a short-lived access token at `personal.connectapi.garmin.com`.
2. It reads HRV, sleep and daily summaries for the days it needs.
3. It submits one row per day to your Google Form's `formResponse` URL, and the Form writes it to the linked Sheet.

Garmin files last night's sleep, HRV and overnight heart rate under **today's** date, and those are final by morning, so today's row is sent right away with just the overnight fields. Today's totals (steps, stress, Body Battery, heart rate) keep changing until midnight, so they're held back, and the complete row for the day is sent on the first run after it ends. Each run also re-pulls the last 3 days, because Garmin sometimes revises recent data, and submits only days that are new or changed. It checks each submission against Google's confirmation page and stops with an explanation if Google rejects it.

## Columns

| Field | Personal API endpoint | Notes |
|---|---|---|
| `date` | — | `YYYY-MM-DD` |
| `hrv_last_night`, `hrv_5min_high`, `hrv_weekly_avg`, `hrv_status`, `hrv_baseline_low`, `hrv_baseline_high` | `/hrv-service/hrv/daily/{start}/{end}` | Overnight HRV in ms |
| `sleep_score`, `sleep_hours`, `deep_hours`, `rem_hours`, `overnight_hr` | `/sleep-service/sleep/dailySleepSummariesByDate` | Durations in hours; `overnight_hr` is average heart rate while asleep, in bpm |
| `resting_hr`, `min_hr`, `max_hr`, `body_battery_high`, `body_battery_low`, `avg_stress`, `steps` | `/usersummary-service/v2/dailysummaries` | Falls back to `/usersummary-service/usersummary/daily` one day at a time |
| `readiness_score`, `readiness_level` | — | Left blank: the Personal API doesn't provide training readiness |

Requests are split to stay within Garmin's per-request range limits (28 days for HRV, 31 for sleep, 365 for daily summaries).

## Setup (about 15 minutes)

You need Node 18 or newer (`node --version`).

### 1. Create a Garmin Personal API key

1. Sign in at [connect.garmin.com](https://connect.garmin.com) and open **[Personal API Key](https://connect.garmin.com/app/settings/personalApiToken)**.
2. Click **Create Key**, read and accept the terms, choose an expiration period, and click **Create**.
3. Copy the key. **Garmin shows it only once**, so treat it like a password.

Garmin emails you about a week before a key expires. When that happens, create a new key and put it in your config file.

### 2. Create the Google Form

If you already have the form from the userscript version, just add one more Short answer question at the end titled `overnight_hr`, then redo step 3 to get a new pre-filled link. The script warns about, and skips, any field your form doesn't have.

1. At [forms.google.com](https://forms.google.com), create a form with 21 **Short answer** questions, none required. Title each one exactly as follows, in this order:

   ```
   date
   hrv_last_night
   hrv_5min_high
   hrv_weekly_avg
   hrv_status
   hrv_baseline_low
   hrv_baseline_high
   resting_hr
   min_hr
   max_hr
   sleep_score
   sleep_hours
   deep_hours
   rem_hours
   body_battery_high
   body_battery_low
   avg_stress
   steps
   readiness_score
   readiness_level
   overnight_hr
   ```

   This version doesn't fill the two `readiness_` questions. Keep them if you have older rows from the userscript; otherwise you can leave them out.

2. Under **Settings → Responses**, turn **off** "Collect email addresses" and "Limit to 1 response". Either one forces sign-in and blocks the script.
3. On the **Responses** tab, click **Link to Sheets** and create a new spreadsheet.
4. Click **Publish**.

### 3. Get the pre-filled link

1. Open the **⋮** menu and choose **Get pre-filled link**.
2. In each box, type that question's own title (`date` in the date box, `hrv_last_night` in the next, and so on).
3. Click **Get link**, then **Copy link**.

The script reads this link to map each field to the form's hidden entry IDs.

<details>
<summary>Can't find "Get pre-filled link"?</summary>

Open the published responder link, then run this in the browser's DevTools console. It builds the same link from your question titles and copies it to the clipboard:

```js
const u = new URL(location.origin + location.pathname);
u.searchParams.set('usp', 'pp_url');
for (const it of FB_PUBLIC_LOAD_DATA_[1][1]) if (it[4]) u.searchParams.set('entry.' + it[4][0][0], it[1]);
copy(u.toString()); console.log(u.toString());
```

If Chrome blocks pasting into the console, type `allow pasting` first.
</details>

### 4. Configure

Clone this repo, then create `~/.config/garmin-sheet-sync/config.json`:

```bash
git clone https://github.com/emarshak/garmin-sheet-sync.git
mkdir -p ~/.config/garmin-sheet-sync
nano ~/.config/garmin-sheet-sync/config.json
```

```json
{
  "apiKey": "YOUR_GARMIN_PERSONAL_API_KEY",
  "prefillUrl": "https://docs.google.com/forms/d/e/…/viewform?usp=pp_url&entry.…"
}
```

Then restrict it to your user, since it holds your API key:

```bash
chmod 600 ~/.config/garmin-sheet-sync/config.json
```

### 5. Test

```bash
cd garmin-sheet-sync
node garmin-sheet-sync.mjs --check                   # verifies the key and the form link
node garmin-sheet-sync.mjs --dry-run --backfill 7    # shows a week of rows without submitting
node garmin-sheet-sync.mjs                           # first real sync: backfills 90 days
```

### 6a. Run it on GitHub Actions (recommended)

The workflow in [`.github/workflows/sync.yml`](.github/workflows/sync.yml) runs the script on GitHub's servers every 2 hours, so it works whether or not your computer is on. Scheduled workflows are free on public repos. Use this **or** launchd (6b), not both: each keeps its own record of what it sent, so running both doubles your rows.

1. **Fork or use your copy of this repo.** Your secrets stay in your repo and are never shown in its code or logs.
2. **Add two repository secrets** under **Settings → Secrets and variables → Actions → New repository secret**:
   - `GARMIN_API_KEY`: your Personal API key
   - `PREFILL_URL`: your form's pre-filled link
3. **Run it once by hand:** open **Actions → Sync Garmin to Google Sheet → Run workflow**. The log should end with `Synced: N submitted, M unchanged`.
4. **If you were running launchd before,** remove that job: `launchctl bootout gui/$(id -u)/com.garmin-sheet-sync`.

How it behaves:
- **Time zone:** the workflow sets `TZ: America/New_York` so "today" matches Garmin's dates. Change it to yours in `sync.yml`.
- **State:** the record of sent days (dates and hashes, no health data) is kept in an Actions cache between runs. If the cache is ever lost, the next run looks back only 3 days (`FIRST_RUN_DAYS`), so at worst a few days get a second row.
- **Backfill:** **Run workflow** takes an optional number of days to re-pull.
- **Public logs:** logs of a public repo's Actions runs can be read by anyone. The script logs only dates and counts there, and it refuses `--dry-run` and `--dump`, which print your data. Use those on your own computer.
- **Schedule timing:** GitHub can start scheduled runs late, sometimes by an hour, and skips some runs when it's busy. The next run catches up.
- **60-day pause:** GitHub disables scheduled workflows in a public repo after 60 days with no commits, and emails you first. Re-enable it with one click on the Actions tab.
- **Key expiry:** when Garmin emails that your key is expiring, create a new one and update the `GARMIN_API_KEY` secret.

### 6b. Or run it on your Mac (launchd)

Keep the repo outside `~/Documents`, `~/Desktop` and `~/Downloads`: macOS blocks background jobs from reading those folders. From the repo folder, fill in the template, install it, and run it once as a test:

```bash
sed -e "s|REPLACE_ME_NODE_PATH|$(which node)|" \
    -e "s|REPLACE_ME_REPO_PATH|$(pwd)|" \
    -e "s|REPLACE_ME_HOME|$HOME|g" \
    launchd/com.garmin-sheet-sync.plist > ~/Library/LaunchAgents/com.garmin-sheet-sync.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.garmin-sheet-sync.plist
launchctl kickstart gui/$(id -u)/com.garmin-sheet-sync
tail ~/Library/Logs/garmin-sheet-sync.log
```

To change the schedule later, unload the job with `launchctl bootout gui/$(id -u)/com.garmin-sheet-sync`, then repeat the `sed` and `bootstrap` steps. Running only the `bootout` removes the job. If you installed Node with nvm, repeat them after upgrading Node too, since `which node` points to a specific version.

It runs every 2 hours and once when you log in. A run that's due while the Mac is asleep happens when it wakes, so last night's sleep and HRV land soon after you open the laptop in the morning, and the previous day's row is completed on the first run after midnight. Runs where nothing changed submit nothing, and a run that fails (for example, before Wi-Fi reconnects after waking) is covered by the next one. If the Mac is shut down, the next run fills in the last 3 days. Output goes to `~/Library/Logs/garmin-sheet-sync.log`. To run it immediately: `launchctl kickstart gui/$(id -u)/com.garmin-sheet-sync`.

## Commands

| Command | What it does |
|---|---|
| `node garmin-sheet-sync.mjs` | Sync last night's sleep, HRV and overnight HR, yesterday's full day, and any revised days |
| `--backfill 365` | Re-pull the last N days; only changed days are resubmitted |
| `--dry-run` | Print the rows instead of submitting them |
| `--dump 2026-10-20` | Print Garmin's raw responses and the parsed row for one day |
| `--check` | Verify the API key and form link |
| `--reset` | Forget which days were sent, so the next run resends its whole window |

Optional settings in `config.json`: `firstRunDays` (default `90`; the `FIRST_RUN_DAYS` environment variable overrides it), `overlapDays` (`3`), `requestDelayMs` (`250`). `GARMIN_API_KEY` and `PREFILL_URL` environment variables override the file.

The script records which days it has sent, as dates and hashes of their values, in `~/.config/garmin-sheet-sync/state.json` (or the folder in `GARMIN_SHEET_SYNC_DIR`).

## Duplicate rows

Google Forms can only append, so each date normally gets two rows: a morning row with sleep and HRV, then the complete row the next day. If Garmin revises a day, that adds another. The latest row for a date is always the most complete. To get one row per day (the latest), add a tab named `Daily` with:

- **A1:** `={'Form Responses 1'!A1:V1}`
- **A2:** `=SORT(SORTN(SORT(FILTER('Form Responses 1'!A2:V,'Form Responses 1'!B2:B<>""),1,FALSE),9^9,2,2,TRUE),2,TRUE)`

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Garmin rejected the API key` | The key is wrong, revoked or expired. Create a new one and update `config.json` |
| `Missing apiKey and prefillUrl` | `config.json` is missing or in the wrong place |
| `Form rejected …: the form requires sign-in` | Turn off email collection and "Limit to 1 response" |
| `Form rejected …: the form is not published` | Publish the form and make sure it's accepting responses |
| `Form rejected …: form not found` | Use the responder link (`/forms/d/e/.../viewform`), not the editor link |
| `Garmin rate limit hit (429)` | Wait and run again, or raise `requestDelayMs` |
| A column is always empty | Garmin's field name differs from what the script expects. Run `--dump` for a recent date and check the field names in the raw response |
| The launchd job doesn't run | Check `~/Library/Logs/garmin-sheet-sync.log`, and that the node path in the plist matches `which node` |

## Notes

- **Read the Personal API terms** when you create the key. Garmin's developer terms restrict passing data to other parties; this script sends only your own data to your own Google Form.
- **Privacy.** Anyone with your form's link can submit rows to it. Keep the link and `config.json` private, and keep the Sheet's sharing restricted.
- Not affiliated with or endorsed by Garmin.

## License

[MIT](LICENSE)
