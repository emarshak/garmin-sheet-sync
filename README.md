# Garmin Connect → Google Sheet sync

A Tampermonkey userscript that copies daily health metrics from Garmin Connect into a Google Sheet, one row per day: HRV, resting heart rate, sleep, Body Battery, stress, steps and training readiness.

It runs inside your own signed-in Garmin Connect tab, so no Garmin password or API token is stored anywhere. Rows are submitted to a Google Form that is linked to a Sheet, so no Google Apps Script or OAuth is needed. This works even on Google accounts with Advanced Protection, which blocks Apps Script web apps.

## Why this exists

- Garmin's official Health and Activity APIs are only open to approved business partners, and new applications are paused.
- Garmin doesn't sync HRV to Apple Health.
- A Sheet is easy to chart yourself and easy for other tools (spreadsheets, notebooks, AI assistants with Google Drive access) to read.

## How it works

1. When you open `connect.garmin.com`, the script reads your data from the same internal JSON endpoints (`/gc-api/...`) the Garmin web app uses, with your existing session.
2. It builds one row per day and submits each row to your Google Form's `formResponse` URL.
3. The Form writes each submission to its linked Sheet.

It syncs automatically on page load if the last sync was more than 6 hours ago. It re-pulls the last 3 days, because Garmin revises recent data, and only resubmits days whose values changed. Each submission is checked against Google's confirmation page, and the sync stops with an explanation if Google rejects it.

## Columns

| Field | Source endpoint | Notes |
|---|---|---|
| `date` | — | `YYYY-MM-DD` |
| `hrv_last_night`, `hrv_5min_high`, `hrv_weekly_avg`, `hrv_status`, `hrv_baseline_low`, `hrv_baseline_high` | `hrv-service/hrv/daily/{from}/{to}` | Overnight HRV in ms |
| `resting_hr`, `min_hr`, `max_hr` | `usersummary-service/usersummary/daily/{displayName}` | bpm |
| `body_battery_high`, `body_battery_low`, `avg_stress`, `steps` | same daily summary | |
| `sleep_score`, `sleep_hours`, `deep_hours`, `rem_hours` | `sleep-service/stats/sleep/daily/{from}/{to}` | Durations in hours |
| `readiness_score`, `readiness_level` | `metrics-service/metrics/trainingreadiness/{date}` | Morning (on-wake) value when available |

Range endpoints are queried in 28-day windows; Garmin rejects longer ranges.

## Setup (about 10 minutes)

### 1. Create the Google Form

1. At [forms.google.com](https://forms.google.com), create a form with 20 **Short answer** questions, none required. Title each one exactly as follows, in this order:

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
   ```

2. Under **Settings → Responses**, turn **off** "Collect email addresses" and "Limit to 1 response". Either one forces sign-in and blocks the script.
3. On the **Responses** tab, click **Link to Sheets** and create a new spreadsheet.
4. Click **Publish**.

### 2. Get the pre-filled link

1. Open the **⋮** menu and choose **Get pre-filled link**.
2. In each box, type that question's own title (`date` in the date box, `hrv_last_night` in the next, and so on).
3. Click **Get link**, then **Copy link**.

The script reads this link to map each field to the form's hidden entry IDs.

<details>
<summary>Can't find "Get pre-filled link"?</summary>

Open the published responder link, then run this in the DevTools console. It builds the same link from your question titles and copies it to the clipboard:

```js
const u = new URL(location.origin + location.pathname);
u.searchParams.set('usp', 'pp_url');
for (const it of FB_PUBLIC_LOAD_DATA_[1][1]) if (it[4]) u.searchParams.set('entry.' + it[4][0][0], it[1]);
copy(u.toString()); console.log(u.toString());
```

If Chrome blocks pasting into the console, type `allow pasting` first.
</details>

### 3. Install the userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) for Chrome.
2. Go to `chrome://extensions`, open **Details** on Tampermonkey, and turn on **Allow User Scripts**.
3. Click the Tampermonkey icon, choose **Create a new script**, and replace the editor contents with [`garmin-sheet-sync.user.js`](garmin-sheet-sync.user.js).
4. Set `PREFILL_URL` in the `CONFIG` block to the link from step 2, and save.

### 4. Sync

Open [connect.garmin.com](https://connect.garmin.com) while signed in. A **Sync → Sheet** button appears in the bottom-right corner, and the first run backfills 90 days.

## Configuration

All settings are in the `CONFIG` block at the top of the script:

| Setting | Default | Purpose |
|---|---|---|
| `PREFILL_URL` | — | Your form's pre-filled link (required) |
| `FIRST_RUN_DAYS` | `90` | Backfill window on the first sync |
| `OVERLAP_DAYS` | `3` | Recent days to re-pull on each sync |
| `AUTO_SYNC_MIN_HOURS` | `6` | Auto-sync on page load if the last sync is older than this |
| `REQUEST_DELAY_MS` | `250` | Pause between Garmin calls and between form submissions |
| `DEBUG` | `true` | Log raw Garmin responses to the console; set to `false` once verified |

## Tampermonkey menu

On a Garmin Connect page, the Tampermonkey icon offers:

- **Sync now**
- **Full backfill (90 days)** / **Full backfill (365 days)**
- **Reset sync state (resends everything)**: clears the record of which days were sent

## Duplicate rows

Google Forms can only append. When Garmin revises a day, the next sync adds a second row for that date with a newer timestamp. To get one row per day (the latest), add a tab named `Daily` with:

- **A1:** `={'Form Responses 1'!A1:U1}`
- **A2:** `=SORT(SORTN(SORT(FILTER('Form Responses 1'!A2:U,'Form Responses 1'!B2:B<>""),1,FALSE),9^9,2,2,TRUE),2,TRUE)`

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Set PREFILL_URL in the script first.` | `PREFILL_URL` still has the placeholder value |
| `Form rejected: form requires sign-in` | Turn off email collection and "Limit to 1 response" |
| `Form rejected: form is not accepting responses` | Publish the form and make sure it's accepting responses |
| `Form rejected: form URL not found` | Use the responder link (`/forms/d/e/.../viewform`), not the editor link |
| A column is always empty | Garmin's field name differs for your account or device. With `DEBUG: true`, find the endpoint's raw response in the console (filter for `[garmin-sync]`) and update the matching `pick(...)` call |
| Garmin requests fail with 401/403 | Sign in to Garmin Connect again and reload |
| Everything was working and then stopped | Garmin likely changed an internal endpoint; compare against the requests the Garmin web app makes in the DevTools Network tab |

## Caveats

- **Unofficial.** These are undocumented Garmin endpoints and can change without notice.
- **Terms of service.** Automated access to Garmin Connect is a gray area under Garmin's terms. This script only reads your own data, at personal scale, from your own signed-in session.
- **Manual trigger.** Data is only as fresh as your last visit to Garmin Connect. Backfill covers any gaps.
- **Privacy.** Anyone with your form's link can submit rows to it. Keep the link private, and keep the Sheet's sharing settings restricted.

## License

[MIT](LICENSE)
