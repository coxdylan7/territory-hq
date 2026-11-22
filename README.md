# Territory HQ — Supabase Edition

Multi-user territory management app with an Express API, a Vite/React web app, and
a store/ambassador portal. Data lives in Supabase Postgres. The API connects with
a server-side `DATABASE_URL`; browsers do not talk to the Supabase Data API.

## What's inside

```
api/src/server.js                  Express REST API (auth, data, admin, cross-app reads)
api/src/cross-app-auth.js          token -> owner_user_id resolution (server-side secret)
api/src/cross-app-queries.js       owner-scoped SQL builders for cross-app reads
api/src/cross-app-handlers.js      cross-app request handlers
api/src/session-cookie.js          HttpOnly first-party session cookie helpers
api/src/session-auth.js            cookie session lookup + explicit legacy bearer opt-in
api/src/csrf.js                    Origin validation for cookie-authenticated mutations
api/src/security-headers.js        CSP and supporting response headers
api/test/                          Node built-in tests for both security phases
web/src/                           main React web app
portal/api/src/server.js           store/ambassador portal API
portal/web/src/                    portal React app
supabase/migrations/               imperative Postgres migrations
```

## Security model (first security phase)

Supabase grants and Row Level Security are separate controls, and both are used:

- All 15 known application tables in `public` have RLS enabled and forced, both
  in migrations and when `ensureSchema()` creates tables at runtime.
- `anon` and `authenticated` have **all privileges revoked** on those 15 tables.
  Unrelated public objects, including extension functions, are not touched.
  They cannot reach application data through the Data API (PostgREST/GraphQL).
- Default privileges are also revoked for future public tables, sequences, and
  functions created by the `postgres` role, for all Data API roles. New objects
  stay private until an explicit grant is added in a reviewed migration.
- The API uses `DATABASE_URL` over a direct/pooler Postgres connection as the
  `postgres` role. That server-side path is intentionally preserved; do not put
  `DATABASE_URL` in a browser bundle or client-side environment variable.
- Existing `service_role` grants are left alone. Future grants to it must be
  explicit. It is a secret server-only role and is not used by the browser apps.
- If you later need Data API access for any object, add a narrow `GRANT` **and**
  an owner-aware RLS policy in the same migration. Do not re-enable blanket
  `anon`/`authenticated` access.

Cross-app reads are owner-scoped:

- `CROSS_APP_TOKENS_JSON` is a server-side secret mapping opaque bearer tokens to
  exactly one `owner_user_id` each.
- The owner id is resolved from the presented token only. Query/body parameters
  such as `ownerUserId` are ignored.
- Missing or malformed configuration denies all cross-app requests.
- Legacy `READ_TOKEN` is **not supported**. Setting it has no effect; there is no
  insecure compatibility opt-in in this phase.

## Browser sessions, CSRF and CSP (second security phase)

First-party HQ and portal sessions are HttpOnly cookies (`thq_session` and
`tp_session`), not browser-readable tokens:

- Set on HQ signup/login and portal login/invite activation; cleared on logout.
- Flags: `Path=/`, `HttpOnly`, `SameSite=Lax`, 30-day `Max-Age`. `Secure` is set
  when `NODE_ENV=production` or `COOKIE_SECURE=1`.
- Auth JSON returns the user only; no session token is written to
  `localStorage`, `sessionStorage`, or JSON. Every first-party `fetch` uses
  `credentials: 'include'`.
- `ALLOW_LEGACY_BEARER_SESSION=1` temporarily allows an Authorization bearer
  token **for session lookup only**. It never writes that token back to browser
  storage. Owner-scoped cross-app bearer tokens are unaffected and remain the
  only credential accepted by the cross-app GET routes.

Cookie-authenticated state changes are protected by fail-closed Origin/fetch
metadata validation:

- `POST`, `PUT`, `PATCH` and `DELETE` carrying `thq_session` or `tp_session`
  reject missing, empty and `null` `Origin`, any cross-origin value, and
  `Sec-Fetch-Site: cross-site`.
- An allowed `Origin` must exactly match `PUBLIC_ORIGIN` or
  `FIRST_PARTY_ORIGINS`; when neither is configured, it must exactly match the
  request origin derived from Express `req.protocol` and `Host`. Wildcards,
  suffixes, paths and userinfo never match.
- A request without `Origin` is accepted only when it carries no session cookie
  and no browser `Sec-Fetch-Site` header (a non-browser client), or when the
  explicitly tested `ALLOW_LEGACY_BEARER_SESSION=1` bearer path is enabled.
- `ALLOWED_ORIGINS` is not reused for CSRF because it configures cross-app
  bearer GET consumers. A rejected mutation returns HTTP 403 with
  `{"error":"cross-origin request blocked"}`.
- Raw `x-forwarded-*` headers are ignored. `TRUST_PROXY` must be set explicitly
  before Express uses them to derive `req.protocol`.

Content-Security-Policy and supporting headers are emitted by both Express
apps and mirrored as a meta CSP in the Vite HTML shells:

- `default-src 'self'`, no inline/eval scripts, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- `'unsafe-inline'` remains in `style-src` because existing React components
  use inline `style` props. Leaflet tiles, Google Maps/API assets, Google
  Fonts, NY Open Data, Nominatim and OSRM are the only external sources listed.
- The printable report is escaped by a tested helper, written into exactly one
  writable `about:blank` window, isolated by clearing `opener` immediately, and
  printed by the opener so no inline script is needed in the generated document.

CORS is split by credential type:

- Exact `PUBLIC_ORIGIN`/`FIRST_PARTY_ORIGINS` values receive reflected
  `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and
  `GET, POST, PUT, PATCH, DELETE, OPTIONS`.
- Exact `ALLOWED_ORIGINS` values receive cross-app bearer CORS with
  `GET, OPTIONS` only and no credentials. No wildcard is ever reflected.

## 1. Prepare Supabase

1. Create a Supabase project.
2. Apply the migrations from this repository, for example:

   ```sh
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push --remote
   ```

   The security migration is
   `supabase/migrations/20261122002427_secure_public_data_api.sql`. It is
   idempotent and can be re-run safely.
3. In Dashboard → Project Settings → Database → Connection string, copy the
   transaction-pooler connection string. Use it only as the server-side
   `DATABASE_URL`.
4. In Data API settings, leave “Automatically expose new tables” disabled. The
   migration's revoked default privileges are a second layer of protection.

Do not paste connection strings, tokens, or mapping JSON into issues, chat, or
client-side code.

## 2. Configure server secrets

Copy `api/.env.example` to `api/.env` for local development, or set the same
variables as site environment variables in Netlify. Do not read or copy `.env`
into a build command or repository file. See `docs/netlify-deployment.md` for
the exact two-site configuration.

| Name | Purpose |
|------|---------|
| `DATABASE_URL` | Required. Supabase Postgres transaction-pooler connection string. Server-side secret. |
| `CROSS_APP_TOKENS_JSON` | Optional. JSON map of opaque token → one `owner_user_id`. Empty means cross-app reads are denied. Server-side secret. |
| `PUBLIC_ORIGIN` | Canonical exact browser origin (`scheme://host[:port]`). Used for credentialed CORS and CSRF; no wildcard or path. |
| `ALLOWED_ORIGINS` | Optional exact origins for cross-app bearer GET CORS only. Empty disallows cross-origin reads; `*` is ignored. Not used for CSRF or cookies. |
| `FIRST_PARTY_ORIGINS` | Additional exact browser origins for credentialed CORS and cookie-authenticated mutations. Empty means `PUBLIC_ORIGIN`/same-origin only. |
| `TRUST_PROXY` | Optional explicit Express trust-proxy hop count or proxy address list. Empty means `x-forwarded-*` headers are ignored. |
| `COOKIE_SECURE` | Optional `1`/`true` to force the `Secure` cookie flag outside `NODE_ENV=production`. |
| `ALLOW_LEGACY_BEARER_SESSION=1` | Temporary session-lookup compatibility for old bearer clients. Remove after migration; it never writes tokens to browser storage. |
| `ADMIN_EMAIL` | Optional email that should receive admin role on signup. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Optional SMS sending. |
| `ANTHROPIC_API_KEY` | Optional AI message drafting. |
| `SKIP_SCHEMA` | Optional `1` to skip boot-time `CREATE TABLE IF NOT EXISTS` setup. |
| `PORT` | HTTP port (default `8080` for the main API, `8081` for the portal). |

Example mapping shape (replace every placeholder; never commit real values):

```json
{"REPLACE_WITH_TOKEN_A":"owner-id-a","REPLACE_WITH_TOKEN_B":"owner-id-b"}
```

Use a strong random value for each opaque token; `openssl rand -hex 32` is one
option. Tokens are opaque strings with no fixed format — any non-empty string is
accepted. Exact owner ids come from your `users.id` values.

## 3. Deploy

Netlify is the authoritative web hosting target for
`github.com/coxdylan7/territory-hq`. Use two independent Netlify sites from
this repository. The full, exact UI settings, environment gates, smoke tests,
rollback steps, and runtime blocker are in
`docs/netlify-deployment.md`.

| Site | Package directory | Base directory | Config | Publish | Functions |
|------|-------------------|----------------|--------|---------|-----------|
| HQ | repository root (leave blank) | repository root (leave unset) | `netlify.toml` | `web/dist` | `netlify/functions` |
| Portal | `portal` | repository root (leave unset) | `portal/netlify.toml` | `portal/web/dist` | `portal/netlify/functions` |

Both sites use Node `22.12.0`. Each `/api` and `/api/*` request is rewritten
before the SPA fallback to a Netlify Function that calls the existing Express
app; the browser never talks directly to Supabase. Set `DATABASE_URL`,
`SKIP_SCHEMA=1`, `PUBLIC_ORIGIN`, `FIRST_PARTY_ORIGINS`, and `TRUST_PROXY=1` as
site environment variables on both sites, plus `PORTAL_URL` on HQ and optional
existing secrets as documented in the runbook. Never expose `DATABASE_URL` to a
Vite bundle.

Deploy HQ first, then Portal, and run the smoke tests in the runbook before
switching traffic. Render and Railway are legacy, non-authoritative hosting
paths retained only as a temporary rollback option; `render.yaml` and the
Dockerfiles remain for local/Docker use and disaster recovery.

Build and start locally:

```sh
npm run build          # builds web/
npm --prefix portal run build
npm run dev:api
npm --prefix portal start
```

> `POST /api/messages/blast` is bounded for Netlify: at most 10 recipients per
> request, 5 concurrent Twilio sends with an 8-second timeout each, and a
> documented 28-second worst case including headroom. Larger selections are
> chunked by the web client, and each batch is idempotent. See
> `docs/netlify-deployment.md` for the operational limits and smoke tests.

## 4. First run

1. Open the web app → **Create account** → the first account becomes admin (or
   use `ADMIN_EMAIL`).
2. App Settings → paste a domain-restricted Google Maps key → Save.
3. Approve members in the Admin tab and set subscription dates.
4. Create store/ambassador invitations from the portal screens.

## 5. Cross-app API

Each consumer gets its own opaque token mapped to its own owner id. The owner
scope is applied in SQL, not by trusting the caller.

```
GET /api/credits/balances?license=OCM-XXXX
GET /api/messages/shared?license=OCM-XXXX
Authorization: Bearer <OWNER_SCOPED_TOKEN>
```

Responses contain only rows where `credits.user_id` / `messages.user_id` equals
the `owner_user_id` configured for that token. The `license` filter is optional.
Unknown tokens, legacy `READ_TOKEN` values, and malformed configuration return
`401 unauthorized`.

## 6. Tests and verification

```sh
npm test                       # root config/adapters + all four package suites
npm --prefix api test          # API security tests; no database required
npm --prefix portal/api test   # portal session regression tests
npm --prefix web test          # report escaping and print-window tests
npm --prefix web run build
npm --prefix portal/web run build
git diff --check
git status --short
```

The tests cover default denial, owner resolution, fail-closed configuration,
owner-required SQL helpers, report HTML escaping, cookie flags/set-clear,
cookie authentication, explicit legacy bearer opt-in, HTTP-level CSRF rejection,
owner-scoped cross-app GET behavior, no token storage/JSON exposure, CSP policy,
and documentation. They do not connect to Supabase. Database behavior should be
verified separately in a disposable local/branch database with
`supabase db reset` and `supabase test db`.

## Honest notes / limitations

- This phase locks down Data API access with grants + forced RLS, but does not
  add per-row Supabase Auth policies because this app authenticates in Express
  with its own session tables. All data access should continue through the API.
- The migration uses the `postgres` role assumption from the existing sample
  connection string. If your `DATABASE_URL` uses a different owner role without
  `BYPASSRLS`, verify access in a non-production branch before deploying.
- No insecure `READ_TOKEN` compatibility shim is provided. Migrating consumers
  must be issued owner-scoped tokens.
- Sessions last 30 days; suspending a member kills their sessions immediately.
- Password resets and self-serve payments are still not implemented.
- The meta CSP cannot enforce `frame-ancestors`; that directive works only as an
  HTTP header. Express deployments receive both `frame-ancestors 'none'` and
  `X-Frame-Options: DENY` from `securityHeadersMiddleware`. Static Vite hosting is
  supported only when the host applies the provided `web/public/_headers` or
  `portal/web/public/_headers` (Vite copies them into `dist`). A static host that
  ignores these files is unsupported for clickjacking purposes.
- `style-src 'unsafe-inline'` is a compatibility allowance for existing inline
  React styles. It is not needed for scripts; `script-src` has no
  `unsafe-inline`/`unsafe-eval`.
- The legacy public/index.html retired: its unescaped print export and inline
  print script are no longer part of any deploy surface. Only the Vite builds
  in `web/dist` and `portal/web/dist` are published; on Netlify, `/api/*` is
  served by a same-origin function adapter around the existing Express app.
  The retired direct-browser Supabase API is not restored.
- Cookies use `SameSite=Lax`. Production should keep HQ/portal web and API on
  the same site, or configure exact `PUBLIC_ORIGIN`/`FIRST_PARTY_ORIGINS` for
  same-site cross-origin apps. True cross-site cookies would additionally need
  `SameSite=None; Secure`, which is not enabled here.
- CSRF uses Origin/fetch metadata rather than per-form tokens. Missing Origin is
  accepted only for non-browser clients with no session cookie and no
  `Sec-Fetch-Site` header, or for the temporary explicit legacy bearer path.
- `PUBLIC_ORIGIN`/`FIRST_PARTY_ORIGINS` must be exact configured values.
  Forwarded headers are ignored unless `TRUST_PROXY` is set to a trusted hop
  count or proxy address list.
- `ALLOW_LEGACY_BEARER_SESSION=1` is temporary compatibility only. Plan to
  remove it after every first-party client uses cookies.
