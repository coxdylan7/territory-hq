# Netlify deployment runbook (Territory HQ + Portal)

Netlify is the authoritative web hosting target for this repository. Source:
`https://github.com/coxdylan7/territory-hq`. Supabase migrations are handled
separately by `docs/supabase-deployment-runbook.md`; this document covers web
hosting only. No command below reads `api/.env`, prints a secret, contacts
production, or deploys anything by itself.

## Architecture

Two independent Netlify sites are built from the same GitHub repository:

- **HQ site:** Vite app in `web/`, API in `api/`, Netlify Function in
  `netlify/functions/hq-api.mjs`.
- **Portal site:** Vite app in `portal/web/`, API in `portal/api/`, Netlify
  Function in `portal/netlify/functions/portal-api.mjs`.

Each `netlify.toml` rewrites exact `/api` and `/api/*` to its own function
before the `/*` SPA fallback. The function converts the web `Request` to a
Lambda-style event with the official `@netlify/aws-lambda-compat` wrapper,
normalizes the path to `/api/*`, and invokes the same Express app used by
Docker/local development through `serverless-http`. The browser talks only to
its own site origin; there is no direct browser-to-Supabase access and no
second API host. Local and Docker startup still call `start()` directly, so
importing the app never opens a listening socket.

Function responses keep the existing security middleware headers. `netlify.toml`
headers cover static files; Netlify custom headers do not apply to function
responses. `SKIP_SCHEMA=1` prevents boot-time DDL in the function runtime.

## Netlify UI site settings

Both sites are Git-connected to `coxdylan7/territory-hq` and deploy from
`main`. These are the exact Git CI settings; the base directory is a site
setting that cannot be set in `netlify.toml`.

| Setting | HQ site | Portal site |
|---|---|---|
| Repository | `coxdylan7/territory-hq` | `coxdylan7/territory-hq` |
| Production branch | `main` | `main` |
| Base directory | unset (repository root) | `portal` |
| Package directory | not required (leave unset) | not required (leave unset) |
| Config file discovered | `netlify.toml` | `portal/netlify.toml` |
| Build command | `npm --prefix api install --no-audit --no-fund && npm --prefix web install --no-audit --no-fund && npm --prefix web run build` | `npm --prefix api install --no-audit --no-fund && npm --prefix web install --no-audit --no-fund && npm --prefix web run build` |
| Publish directory | `web/dist` | `web/dist` |
| Functions directory | `netlify/functions` | `netlify/functions` |
| Node version | `NODE_VERSION = "22.12.0"` | `NODE_VERSION = "22.12.0"` |

Netlify searches the base directory before the repository root for
`netlify.toml`, so Base directory `portal` discovers `portal/netlify.toml`.
Every path in that file resolves from the base: `web/dist` is
`portal/web/dist` on disk and `netlify/functions` is `portal/netlify/functions`
on disk. There is no separate package-directory requirement; leave it unset on
both sites rather than relying on a UI setting that CLI/API automation cannot
set reliably. Netlify installs dependencies at the base, then the build command
installs each site's `api/` and `web/` dependencies and builds its web app. Do
not change the publish directory to the base root: function source must remain
outside the published static assets.

### Shared function code from the Portal base

The Portal function imports the root-level adapter and shared API helpers via
static relative imports outside the base. This is supported by Netlify function
bundling: static imports are followed, and Netlify's esbuild base-path logic
explicitly accounts for `repositoryRoot`
([zip-it-and-ship-it #754](https://github.com/netlify/zip-it-and-ship-it/commit/8b2f8ea951696131b48fa7e624e89c594189ebae)).
The adapter and security-header logic are therefore not duplicated inside
`portal/`. Netlify externalizes bare modules from the bundled function, so every
module in the function graph must be installed at the site base. Both
`package.json` at the repository root and `portal/package.json` therefore
declare `serverless-http`, `@netlify/aws-lambda-compat`, `express`, and
`postgres` at the same versions used by the API packages; the build command
installs each site's `api/` and `web/` packages under `api/` and `web/`. Shared
code stays under the single tested implementation.

## Environment gates

Set these as **site environment variables** on both sites unless the table says
otherwise. Use your secret manager as the source of truth. Never copy `.env`
into a build command, repository file, or browser bundle.

| Name | HQ | Portal | Purpose |
|---|---|---|---|
| `DATABASE_URL` | required | required | Supabase Postgres transaction-pooler URL. Server-side secret only. |
| `SKIP_SCHEMA=1` | required | required | Migrations are already applied; function boot must not issue DDL. A missing or non-`1` value returns 503 without invoking Express. |
| `PUBLIC_ORIGIN` | required | required | Exact canonical browser origin for that site (`scheme://host[:port]`, no path or wildcard). |
| `FIRST_PARTY_ORIGINS` | required in practice | required in practice | Exact additional credentialed origins, comma-separated. HQ normally includes the portal origin; Portal normally includes the HQ origin. |
| `ALLOWED_ORIGINS` | optional | optional | Exact origins permitted for owner-scoped bearer GET CORS only. Wildcards are ignored. |
| `TRUST_PROXY=1` | required | required | Netlify terminates TLS at its proxy. Any other value fails the function environment gate. |
| `DATABASE_MAX` | optional | optional | Per-container Postgres pool cap (default HQ `4`, Portal `10`). `1` is recommended when many warm functions are expected; invalid values are ignored. |
| `PORTAL_URL` | required for invite links | n/a | Exact Portal origin used by HQ to generate store/ambassador invite links. |
| `CROSS_APP_TOKENS_JSON` | optional | n/a | Server-side opaque token → owner map for cross-app reads. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | optional | n/a | SMS credentials. See the bounded blast budget below before enabling blasts. |
| `ANTHROPIC_API_KEY` | optional | n/a | AI message drafting proxy. |
| `ADMIN_EMAIL`, `COOKIE_SECURE`, `ALLOW_LEGACY_BEARER_SESSION` | optional as applicable | n/a | Existing application options. |

The function wrapper checks `DATABASE_URL`, `SKIP_SCHEMA=1`, `PUBLIC_ORIGIN`,
and `TRUST_PROXY=1` before Express is invoked. On failure it returns JSON 503
with only the missing key names; no connection string or other secret value is
echoed.

## Deploy order

1. Confirm the target Supabase migrations are already applied. Do not run DDL
   from Netlify. Confirm all required site variables above are set for the
   target environment.
2. **Deploy HQ first.** Trigger a deploy of the HQ site from `main`; confirm
   the build uses `web/dist` and that `hq-api.mjs` is bundled. Do not switch
   production DNS/traffic yet.
3. **Deploy Portal second.** Trigger a deploy of the Portal site from `main`
   with Base directory `portal`; confirm the base-relative `web/dist`
   (`portal/web/dist` on disk) and `portal-api.mjs` are bundled. Do not switch
   production DNS/traffic yet.
4. Run every smoke test below against each deploy-specific Netlify URL. Check
   the function logs for secrets or stack traces; none should appear.
5. Only after both sites pass, switch DNS/traffic to the Netlify sites. Keep
   the previous hosting available for rollback until the soak period ends.

Environment variable changes require a new deploy before functions pick them
up. Do not assume an edit in the Netlify UI is immediately active.

## Smoke tests

Run these against each site origin:

1. `GET /api/health` returns 200 with `{"ok":true,"service":"hq"}` on HQ and
   `{"ok":true,"service":"portal"}` on Portal. This route does not touch the
   database.
2. `GET /api/does-not-exist` and bare `GET /api` return JSON 404, never the SPA
   `index.html`.
3. `GET /` loads the Vite app and static responses carry the hardened headers
   from `netlify.toml`.
4. Sign in to HQ and Portal. Confirm `thq_session` and `tp_session` are
   `HttpOnly`, `Secure` in production, `SameSite=Lax`, and absent from browser
   storage.
5. Create a portal invite from HQ using `PORTAL_URL`, activate it in Portal,
   and read owner-scoped cross-app data with a configured opaque token. A
   wrong owner must return 404/403.
6. Create a credit grant and a booking; approve and cancel the booking and
   confirm one charge, one exact-inverse refund, and audit rows.
7. Confirm anonymous Supabase Data API REST requests still return no rows.
8. On a staging site with Twilio test credentials, send a bounded blast to at
   most 10 owned accounts. Confirm the response reports `sent` only for
   confirmed Twilio sends, an unconfirmed send is `queued`, a missing phone or
   another owner's account is `skipped`, and a settled partial batch returns
   HTTP 207. Replaying the same `Idempotency-Key` must return the previous
   result without a second SMS.

## Rollback

This migration changes hosting only. If a web deploy fails:

1. **Redeploy the last known-good deploy** for that individual Netlify site.
   Each site has an independent deploy history; do not roll back both sites
   for a single-site fault.
2. If both sites fail, restore DNS/traffic to the previous Render/Railway
   services only after confirming those services are still running and using
   the same database.
3. Correct the missing environment key and trigger a fresh deploy. Do not edit
   generated files in `web/dist` or `portal/web/dist`.
4. Do not roll back Supabase for a web-only failure. Database rollback follows
   the decision points in `docs/supabase-deployment-runbook.md`.

Render and Railway are legacy, non-authoritative hosting paths retained only
as a temporary rollback option. `render.yaml` and the Dockerfiles are not the
primary deployment target.

## Runtime limits and SMS blast budget

Netlify Functions have a 60-second synchronous execution limit and a 6 MB
buffered request/response limit. Normal JSON CRUD, session, booking, and credit
routes fit those limits. `POST /api/messages/blast` is now bounded:

| Limit | Value |
|---|---|
| Recipients per API request | 10 maximum; larger requests return HTTP 413 |
| Twilio timeout per recipient | 8,000 ms, passed explicitly to the fetch call |
| Delivery concurrency | 5 recipients at a time |
| Reserved headroom | 12,000 ms for auth, database, serialization, and cold start |

The API uses a concurrency of 5 Twilio calls at a time. Worst-case Twilio wall
time for one request is `ceil(10 / 5) × 8,000 ms = 16,000 ms`. Adding reserved headroom gives
`16,000 + 12,000 = 28,000 ms`, comfortably below the 60,000 ms synchronous
limit. The browser chunks a larger selection into deterministic batches of at
most 10 recipients and submits those batches sequentially, so each function
invocation stays inside this budget even when the whole selection is large.

Operational behavior:

- The server validates the cap, duplicate recipients, and template independently
  of the web client. A crafted request with 11 recipients is rejected before any
  database or Twilio work.
- Each batch gets a deterministic `Idempotency-Key`. Automatic transport retries
  reuse it; per-recipient idempotency claims prevent a second Twilio send even
  if a response or batch completion is lost.
- `sent` means Twilio confirmed delivery. An unconfirmed send is recorded as
  `queued`; a missing phone or an account owned by someone else is `skipped`; a
  conflicting/lost recipient reservation is `failed`. Any batch where not every
  recipient is `sent` returns HTTP 207 with explicit per-recipient results.
- The UI continues to the next batch after a settled 200/207 response. It stops
  after an HTTP error or transport failure because that batch's state is unknown;
  the user can retry later with the same stable batch keys without duplicate SMS.
- The Send button is guarded against double-submit, and progress shows the batch
  position plus final aggregate counts.

Outcome: **GO** for Netlify with the bounded blast behavior above. A durable
queue/background job is not required for this request size, and Twilio blasts do
not need to be disabled as a Netlify workaround.
