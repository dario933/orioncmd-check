# OrionCmd Post-Deploy Check

[![Action checks](https://github.com/dario933/orioncmd-check/actions/workflows/ci.yml/badge.svg)](https://github.com/dario933/orioncmd-check/actions/workflows/ci.yml)

A free, keyless GitHub Action for a public HTTPS site after deployment.
It runs on the GitHub runner, not OrionCmd's servers. There are no API calls,
account requirements, paid providers, runtime npm dependencies, or recurring monitors.
Normal GitHub Actions runner usage is subject to GitHub's own allowances and pricing.

## What it checks

- The URL responds with an accepted HTTP status (200–299 by default).
- HTTPS certificate trust, hostname, validity dates, and remaining lifetime.
- Every HTTPS host in a redirect chain, not only the final destination.
- Failure at **21 days or fewer** remaining by default, configurable with `minimum-days`.
  Whole days in the output are rounded down; the threshold uses the exact remaining time.
- Up to five redirects, with public-address validation at every hop.
- Temporary network/HTTP failures may be retried to allow a deployment to settle.
  Certificate and unsafe-target failures are not retried.

It writes a GitHub job summary and structured outputs, and fails the step by default
if a check fails. `fail-on-error: 'false'` changes the annotation to a warning and
leaves the step successful, but **the `status` output remains `failed`**.

This is not an automatic certificate renewal tool, a full vulnerability scan,
an uptime-history calculation, or an OrionCmd dashboard integration. No page body
is retained. URL query strings, fragments, and credentials are never printed.

## Run it after your existing deploy job

This repository contains only the standalone, MIT-licensed GitHub Action.
The standalone Action is publicly available at
[dario933/orioncmd-check](https://github.com/dario933/orioncmd-check).
Anyone can read, download, or use it without access to OrionCmd's private app source.
The examples use the `v1` release tag. For production, pin the Action to the full
commit SHA from its release instead of a moving version tag.

Add this job to your workflow containing an existing successful `deploy` job:

```yaml
jobs:
  # Keep your existing deploy job here.
  post-deploy-check:
    needs: deploy
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - name: Check deployed site
        id: orioncmd
        uses: dario933/orioncmd-check@v1
        with:
          url: https://your-deployed-site.example.com
          minimum-days: '21'
          attempts: '3'
          retry-delay-seconds: '5'
          timeout-seconds: '10'
```

Replace the URL with your real deployed site. `needs: deploy` checks only after that
job succeeds. It does not discover deployments automatically; add it to **each**
deployment workflow you want checked. A failed post-deploy check cannot undo a deploy
that has already completed.

You can also pass a URL output from your deploy job:
`url: ${{ needs.deploy.outputs.url }}`.
Do not run privileged deployment workflows on untrusted pull-request code.
On a self-hosted runner this Action deliberately refuses private/internal targets.

To test the Action in this same repository, check out the repository first, then use:

```yaml
- uses: actions/checkout@v7
- uses: ./
  with:
    url: https://your-deployed-site.example.com
```

No OrionCmd API key or `GITHUB_TOKEN` needs to be passed to the Action.

## Opt in to daily checks, even without a deployment

**Post-deploy-only checks cannot detect later certificate expiry if no new
deployment happens.** To keep checking between deployments, optionally save this
separate workflow as `.github/workflows/orioncmd-scheduled-check.yml` in your
repository's **default branch**. Nothing is scheduled merely by using the Action
or reading this example.

```yaml
name: Daily public HTTPS checks
on:
  schedule:
    - cron: '17 8 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  scheduled-check:
    name: Check ${{ matrix.url }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    strategy:
      fail-fast: false
      matrix:
        url:
          - https://your-site.example.com
          - https://your-other-site.example.com
    steps:
      - name: Check public site
        id: orioncmd
        uses: dario933/orioncmd-check@v1
        with:
          url: ${{ matrix.url }}
          minimum-days: '21'
          expected-status: '200-299'
          attempts: '3'
          retry-delay-seconds: '5'
          timeout-seconds: '10'
          fail-on-error: 'true'
```

Replace the matrix URLs with your public HTTPS sites on port 443; remove or add
entries as needed. Do not put credentials or secret query parameters in the
matrix: these URLs appear in job names and workflow source. As with the
post-deploy example, pin the public Action's `uses` reference to a full commit
SHA for production.

This runs daily at **08:17 UTC**, with no `deploy` dependency. Each site gets its
own job and summary; `fail-fast: false` lets the other sites finish when one
fails. The existing Action performs the same HTTPS and availability checks on
GitHub's runner. It does not create OrionCmd monitors, store uptime history,
renew certificates, or require an OrionCmd account or API credentials.
Keep `fail-on-error: 'true'` and do not add `continue-on-error` if you want
failures to trigger GitHub's failed-workflow notifications.

### Enable GitHub failure notifications

Watch the repository, then open your GitHub **Settings → Notifications**.
Under **System → Actions**, choose **Email** and/or **On GitHub**, select
**Only notify for failed workflows**, and save. These are GitHub notifications,
not OrionCmd emails, and they are not enabled automatically by this YAML.
For scheduled runs, GitHub sends notifications to the workflow's initial creator,
or the user who most recently changed its cron schedule; re-enabling a disabled
schedule makes the re-enabling user the recipient. Have the intended recipient
enable their notification preferences. Do not assume every repository watcher
will receive the scheduled-run failures.

After merging the file to the default branch, use **Actions → Daily public HTTPS
checks → Run workflow** to verify the configured URLs, job summaries, and GitHub
notification routing. To test the failure path without waiting for expiry,
temporarily set `minimum-days: '3650'` for an ordinary short-lived certificate,
run manually, confirm the failed run and notification, then restore `'21'`.
Both the schedule and this manual trigger use the same inputs.

### Schedule limitations and runner allowances

- GitHub schedules run from the default branch. Scheduled runs can be delayed,
  and under heavy load some queued runs may be dropped. The off-hour minute
  above avoids the busiest start-of-hour period but does not guarantee delivery.
- In public repositories, GitHub automatically disables scheduled workflows
  after **60 days without repository activity**. Check the Actions tab and
  re-enable the workflow if needed. This is particularly important for sites
  that rarely deploy: this example is not a guaranteed, always-on monitoring
  service.
- The checker itself is free. Standard GitHub-hosted runners are free for public
  repositories; private repositories consume the repository owner's included
  Actions minutes, with usage beyond the plan allowance subject to GitHub
  billing and budget settings. Larger runners have separate charges.
- Each matrix site starts a separate runner job. Daily checks of two sites mean
  about **60 jobs per 30-day month**, plus manual runs and post-deploy checks.
  Runner startup, retries, actual job duration, and GitHub billing rules determine
  minutes used; the five-minute timeout is a limit, not a promised cost.
- Disable or remove this separate workflow to stop scheduled checks without
  changing your post-deploy checks.

See GitHub's current documentation for
[scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[notification routing](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs),
[notification preferences](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications),
and [Actions allowances and billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `url` | Required | Public HTTPS URL on port 443. Paths and query strings are supported; URL credentials are refused. |
| `minimum-days` | `21` | Fail at this many days or fewer remaining (0–3650). Zero still rejects expired certificates. |
| `expected-status` | `200-299` | Accepted final statuses, for example `200,204` or `200-299,304`. |
| `attempts` | `3` | Maximum transient-failure attempts, 1–5. |
| `retry-delay-seconds` | `5` | Delay between attempts, 0–30 seconds. |
| `timeout-seconds` | `10` | Per-hop DNS/TLS/HTTP deadline, 1–30 seconds. |
| `fail-on-error` | `true` | Set `false` for warning-only operation. Invalid configuration always fails. |

The entire check has a two-minute deadline regardless of retry settings.
An unavailable result is a failure, never a fabricated pass.
DNS is pinned per request. Private, loopback, link-local, multicast, documentation,
and other special-use targets are refused, including through redirects.
IPv6 support conservatively permits global unicast space, excluding special-use ranges.
Split-horizon DNS returning any non-public address is refused.

## Outputs

| Output | Meaning |
| --- | --- |
| `status` | `passed` or `failed`. |
| `http-status` | Last observed HTTP status; empty if none was observed. On success, this is the final status. |
| `days-remaining` | Rounded-down days for the earliest-expiring validated certificate observed in the last attempt; empty if unknown. |
| `certificate-expires-at` | That certificate's UTC ISO expiry; empty if unknown. |
| `attempts-used` | Number of attempts made (zero for invalid configuration). |
| `report` | Single-line JSON report, including observed certificates and a failure reason. No page content or input URL is included. |

If HTTPS validation fails, the Action does not disable validation just to read
an untrusted certificate. Certificate outputs can therefore be empty on failure,
or contain only earlier validated redirect hops. Treat them as partial evidence.

## Local verification

Node 24 is used by the Action. For local tests:

```sh
node --test test/*.test.mjs
```

Run a real public-site check without credentials:

```sh
INPUT_URL=https://example.com node src/index.mjs
```

The included CI workflow runs unit tests and exercises the local Action against
`https://example.com`. Its remote execution is not proven until the workflow runs
on GitHub. No Marketplace listing or release tag is created by adding these files.

## License

MIT. See [LICENSE](LICENSE).
