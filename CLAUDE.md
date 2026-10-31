# CLAUDE.md

Guidance for Claude (and anyone else) changing this repo. Security comes first: this is a **public** repo whose code handles a Garmin API key and personal health data, and whose GitHub Actions logs and caches are visible beyond the owner.

## What this repo is

- `garmin-sheet-sync.mjs`: a dependency-free Node script. It exchanges a Garmin Personal API key for a bearer token, reads HRV, sleep and daily summaries, and submits one row per day to a Google Form linked to a Sheet.
- `.github/workflows/sync.yml`: runs the script every 2 hours on GitHub Actions, using repository secrets.
- `launchd/`: alternative schedule for a Mac.
- `deprecated/`: the old Tampermonkey userscript. Don't extend it.

## What must stay protected

| Asset | Where it lives | Must never appear in |
|---|---|---|
| Garmin Personal API key | `GARMIN_API_KEY` secret, or local `~/.config/garmin-sheet-sync/config.json` | the repo, logs, caches, artifacts, error messages, any host but `*.garmin.com` |
| Bearer token (24 h) | memory only | anywhere. GitHub does **not** mask it in logs, because it isn't a secret |
| Pre-filled form link (anyone with it can add rows) | `PREFILL_URL` secret, or local config | the repo, logs |
| Health data (HRV, HR, sleep, stress, steps) | Garmin, the Google Form/Sheet, memory during a run | the repo, Actions logs, caches, artifacts, test fixtures, commit messages, PR text |

## Rules

### Repo contents
- Never commit secrets, `config.json`, `state.json`, `.sync-state/`, or real Garmin responses. `.gitignore` covers the usual paths; don't weaken it.
- Test fixtures must be synthetic. Never paste `--dump` output from a real account into a fixture, issue, PR or commit, even as an example.
- Keep the script free of npm dependencies. If one becomes unavoidable, explain why in the PR, pin an exact version with a lockfile, and avoid packages with install scripts.

### Network destinations
- The script may send the API key and token only to `https://*.garmin.com`, and form data only to `https://docs.google.com/forms/…`. `checkGarminUrl` and `formSetup` enforce this; keep those checks, and don't add destinations, telemetry or webhooks.
- Loopback (`http://127.0.0.1`, `localhost`) is allowed only so tests can use mock servers.
- The Garmin base URL is configurable only through the `GARMIN_BASE_URL` env var, never a file.

### Logging and output
- Under Actions (`GITHUB_ACTIONS=true`), output must contain only dates, counts and generic errors. Keep the `IN_CI` guards: `--dry-run` and `--dump` refuse to run, and errors omit response bodies.
- Never log the API key, token, form link, request headers or response bodies, locally or in CI. Never include the token-exchange response in an error.
- If something sensitive must be printed in CI for debugging, don't. Reproduce it locally instead.

### State file
- `state.json` stores only dates and a truncated SHA-256 of each day's values, never the values. It's restored from an Actions cache, so treat its contents as untrusted: it may only influence which days are resent, never where data goes or which credentials are used.
- Under Actions, the script reads no config file. Keep it that way, since the state folder comes from a cache.

### GitHub Actions workflow
- **Permissions:** keep the top-level `permissions: contents: read`. If a change needs more, grant it on that job only and say why in the PR.
- **Secrets:** expose secrets only in the `env` of the step that runs our own script, never at job or workflow level, and never to a third-party action.
- **Pinning:** pin every third-party action to a full 40-character commit SHA, with the version in a comment (`uses: actions/checkout@<sha> # v7.0.1`). Never use a tag or branch. Use releases at least two weeks old, read the release notes, and confirm the inputs you use still exist.
- **Triggers:** only `schedule` and `workflow_dispatch`. Never add `pull_request_target` or `workflow_run`, and never give secrets to a workflow that runs on `pull_request`, because forks could trigger it.
- **Inputs:** pass `inputs.*` and other `${{ }}` values to scripts through `env`, then quote them (`"$BACKFILL"`). Never interpolate `${{ }}` directly inside `run:`, which allows shell injection.
- **Checkout:** keep `persist-credentials: false`.
- **Caches and artifacts:** cache only `.sync-state/state.json`. Don't upload artifacts. Logs, state and data files would all be visible beyond the owner.
- Keep `concurrency` and `timeout-minutes`.

### Making changes
- Run the script against mock servers on loopback to test changes. Never test against the real account in CI.
- Every PR that touches the workflow, network code, logging or state handling should state in its description how it keeps these rules.

## Review checklist

Before merging any change, confirm:

- [ ] No secrets, form links, tokens or real health data in the diff, fixtures, commit messages or PR text
- [ ] Network calls still go only to `https://*.garmin.com` and `https://docs.google.com/forms/`
- [ ] No new logging of keys, tokens, headers, response bodies or health values; CI guards intact
- [ ] `state.json` still holds only dates and hashes
- [ ] Workflow: `contents: read`, secrets scoped to the script step, actions pinned to SHAs, no new triggers, inputs passed via `env`, `persist-credentials: false`
- [ ] No new dependencies, or a justified and pinned one

## Repo settings (owner)

These live in GitHub settings, not code, so check them occasionally:

- **Settings → Actions → General:** set fork pull request workflows to **Require approval for all external contributors**.
- **Settings → Code security:** keep **Secret scanning** and **Push protection** on, and **Dependabot alerts** on. `.github/dependabot.yml` proposes action updates monthly.
- **Branches:** protect `main` (require a pull request) so workflow changes can't land unreviewed.
- **Secrets:** rotate `GARMIN_API_KEY` when Garmin warns that it's expiring, or immediately if it might have leaked. Revoke it at Garmin Connect → Personal API Key, which cuts off access at once.
