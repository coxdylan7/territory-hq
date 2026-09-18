# Territory HQ — Netlify SaaS Edition

Multi-user version: registration + login, per-member data isolation, admin panel
for approving members and managing subscription dates. Built for marketing to
NY cannabis sales reps.

## What's inside
```
public/index.html            the app (login/signup + full console)
netlify/functions/api.js     the entire backend (auth, data, admin, cross-app API)
netlify.toml                 routes /api/* to the function
```

## How membership works
- Anyone can **create an account** → status starts as `pending`
- The **first account ever created is automatically the admin** (that's you —
  sign up first!). You can also set `ADMIN_EMAIL` so your email always gets admin.
- Pending members see a "awaiting approval" screen until you approve them
- The **Admin tab** (visible only to admins) lists every member: Approve,
  Suspend, set the **Subscription until** date, promote to admin
- When a member's subscription date passes, they see "Subscription expired"
  and lose access until you extend it
- Payments are **managed manually by you** for now (you collect payment however
  you like, then set their date). Stripe checkout can be added as a next step —
  it needs your Stripe account/keys.

## 1. Create the database (Turso — free)
Netlify has no built-in SQL database, so this uses Turso (SQLite-compatible):
1. Sign up at https://turso.tech (free tier: 500 DBs, 9GB — way more than needed)
2. Create a database (any name, e.g. `territory-hq`)
3. From the database page copy:
   - the **URL** (starts with `libsql://...`)
   - create an **auth token** (Database → Tokens → Create token)

Tables are created automatically on first request — no SQL to run.

## 2. Deploy to Netlify
Option A — drag & drop (no CLI, works on phone):
1. app.netlify.com → **Add new site → Deploy manually**
2. Drag the whole project folder (the one containing `public`, `netlify`, `netlify.toml`)
3. Deploy

Option B — connect a GitHub repo with these files; Netlify auto-deploys on push.

## 3. Set environment variables
Site → **Site configuration → Environment variables → Add a variable**:

| Name | Value |
|------|-------|
| `TURSO_DATABASE_URL` | the `libsql://...` URL from Turso |
| `TURSO_AUTH_TOKEN` | the token from Turso |
| `ANTHROPIC_API_KEY` | from console.anthropic.com (for AI message drafts) |
| `READ_TOKEN` | long random string — for your other apps to read credits/messages |
| `ALLOWED_ORIGINS` | comma-separated domains of your other apps (optional) |
| `ADMIN_EMAIL` | your email — guarantees your signup gets admin (optional) |

Then **Deploys → Trigger deploy → Deploy site** so the variables take effect.

## 4. First run
1. Open your `*.netlify.app` URL → **Create account** → you're the admin (first user)
2. App Settings tab → paste your Google Maps key → Save
   (restrict the key to your `*.netlify.app` domain in Google Cloud Console)
3. Share the URL with reps → they sign up → you approve them in the **Admin** tab
   and set their subscription date

## 5. Cross-app API (unchanged pattern)
Your other apps read shared data with the READ_TOKEN:
```
GET https://your-site.netlify.app/api/credits/balances?license=OCM-XXXX
GET https://your-site.netlify.app/api/messages/shared?license=OCM-XXXX
Header: Authorization: Bearer <READ_TOKEN>
```

## Honest notes / next steps
- **Payments**: this version is "admin-approved subscriptions" — you handle money
  outside the app and set dates. Adding Stripe (self-serve checkout, auto-renewal,
  webhooks that extend `subExpires` automatically) is the logical next build and
  needs your Stripe keys.
- **Password resets** aren't built yet — as admin you can't reset passwords from
  the UI; that's another good next step (email-based reset needs an email service).
- Cross-app endpoints currently return data across ALL members (matched by license
  number). If reps should be siloed from each other's credits/messages in
  cross-app reads too, say so and I'll scope those per-member.
- Sessions last 30 days; suspending a member kills their sessions immediately.
