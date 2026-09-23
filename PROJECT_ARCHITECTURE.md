# Project Architecture — Personal AI Daily Dashboard

Status: **Phase 3 complete.** Database, domain model and real persistence are live; the Today dashboard reads and writes Postgres through Supabase Auth. AI planning, reminders and reports are still ahead.

## 1. Product in one line

A personal command center that turns a morning brain-dump into a realistic time-blocked plan, replans as the day changes, and closes with a concise report. The UI answers one question: _"What matters right now, and what should I do next?"_

Non-goals: Notion clone, kanban, chat app, chart-heavy analytics, generic SaaS admin.

## 2. Principles (non-negotiable)

1. **PostgreSQL is the source of truth.** Client state is never persistent state.
2. **Claude is an intelligence layer, not an authority.** Output path: server receives → parse → Zod validate → deterministic business-rule validate → persist. Malformed output: record failure, retry once, re-validate, else controlled error.
3. **Deterministic core.** Scheduling constraints (fixed commitments, deadlines, durations, current time, completed work) are enforced in plain TypeScript, not by the model.
4. **Boundaries.** UI ⟂ domain ⟂ db ⟂ AI ⟂ notifications ⟂ scheduling ⟂ validation ⟂ auth ⟂ config. External services only via adapters.
5. **History is append-only.** Replanning creates a new plan revision; it never mutates or deletes prior ones. Completed tasks are immovable; past deadlines are never silently moved.
6. **Server Components by default.** Client components only for interactivity/animation.
7. **Secrets never reach the browser.** Client-supplied user IDs are never trusted.

## 3. Current state (discovered)

| Item                                        | Finding                                                |
| ------------------------------------------- | ------------------------------------------------------ |
| Project type                                | **Empty project** (git repo + README only)             |
| Commits                                     | 1 (`first commit`)                                     |
| package.json / lockfile                     | none                                                   |
| Source, config (TS, Tailwind, Next, ESLint) | none                                                   |
| Env files, DB config, deployment config     | none                                                   |
| Tests                                       | none                                                   |
| Toolchain                                   | Node v26.0.0, npm 12.0.2, git 2.54; pnpm not installed |

No existing architecture, so no conflicts and nothing to migrate.

## 4. Recommended directory structure

Single Next.js app, App Router, `src/` layout. Dependency direction is inward: `app → features → domain`; `infra` implements interfaces owned by `domain`.

```
src/
  app/                        # routes, layouts, route handlers — thin, no business logic
    (auth)/login/
    (app)/                    # authenticated shell
      today/                  # primary dashboard
      history/  reports/
    api/                      # route handlers (cron, webhooks, AI endpoints)
  features/                   # UI + client hooks per feature; no domain rules
    briefing/ plan/ tasks/ replan/ report/ history/
  components/                 # shared presentational primitives (ui/, layout/)
  domain/                     # pure TS, no I/O, no framework imports
    tasks/ plans/ scheduling/ replanning/ reports/ reminders/
  server/
    db/                       # Supabase clients, repositories, migrations helpers
    ai/                       # claude client adapter, operations, parsers
      prompts/                # centralized, versioned (e.g. plan.v1.ts)
    notifications/            # resend + twilio adapters behind one interface
    auth/                     # session/user resolution (server-only)
    services/                 # orchestration: db + ai + domain (e.g. generatePlan)
    logging/  rate-limit/
  lib/
    validation/               # Zod schemas shared across boundaries
    time/                     # date-fns helpers, timezone handling
    motion/                   # GSAP/Anime setup, reduced-motion gate, tokens
  config/
    env.public.ts / env.server.ts   # Zod-validated env; public vs server-only split
    navigation.ts
supabase/
  migrations/                 # SQL, source-controlled
  seed.sql
tests/
  unit/ (colocated *.test.ts also allowed)  e2e/
```

Rules: `domain/` imports nothing from `server/`, `app/` or React. `server/` files use `import "server-only"`. Route handlers and server actions are thin: authenticate → validate input → call a service → shape response.

## 5. Dependencies

Versions verified against the npm registry on 2026-09-22 (to be re-checked at install time).

| Purpose          | Package                                       | Latest          | Note                                            |
| ---------------- | --------------------------------------------- | --------------- | ----------------------------------------------- |
| Framework        | `next`, `react`, `react-dom`                  | 16.3.x / 19.3.x | App Router                                      |
| Language         | `typescript`                                  | 7.0.2           | **See decision D1**                             |
| Styling          | `tailwindcss` (+ `@tailwindcss/postcss`)      | 4.3.x           | CSS-first config (no `tailwind.config.js`)      |
| Validation       | `zod`                                         | 4.x             |                                                 |
| Dates            | `date-fns` (+ `@date-fns/tz`)                 | 4.x             | Timezone-aware days                             |
| Icons            | `lucide-react`                                | 1.x             |                                                 |
| DB/Auth          | `@supabase/supabase-js`, `@supabase/ssr`      | 2.x / 0.12      |                                                 |
| AI               | `@anthropic-ai/sdk`                           | 0.127           | Server-only                                     |
| Email (later)    | `resend`                                      | 6.x             | Phase-gated                                     |
| WhatsApp (later) | `twilio`                                      | 6.x             | Phase-gated                                     |
| Motion           | `gsap`, `animejs`                             | 3.15 / 4.x      | Anime.js v4 API differs from v3 (named imports) |
| Unit tests       | `vitest`                                      | 5.x             |                                                 |
| E2E              | `@playwright/test`                            | 1.63            |                                                 |
| Lint/format      | `eslint` (+ `eslint-config-next`), `prettier` | 10.x            | Check Next plugin compat with ESLint 10         |
| Misc             | `server-only`, `clsx`                         |                 |                                                 |

Install only what a phase needs; notification, motion and AI packages arrive in their own phases.

## 6. Database approach

- **Supabase Postgres**, schema managed by SQL migrations in `supabase/migrations/` (Supabase CLI), not ad-hoc dashboard edits.
- **Access:** server-side repositories using the user-scoped Supabase client so **RLS enforces ownership**. The service-role key is reserved for cron/webhook jobs and never imported by request-path code that acts for a user.
- **Types:** generated from the schema (`supabase gen types`); repositories map rows to domain types.
- **Core tables (initial):** `profiles` (1:1 `auth.users`, timezone), `days` (user + local date, unique), `briefings` (raw brain-dump, per day), `tasks` (kind: fixed / flexible / deadline / optional / recurring; priority; estimate; due), `task_events` (append-only status history: created, started, completed, skipped, late, rescheduled), `plans` (per day), `plan_revisions` (numbered, reason, source: ai/user, AI prompt version, validation result), `plan_blocks` (revision → task, start/end), `reminders` (channel, scheduled_for, status, idempotency key), `reports` (per day, structured JSON + text), `ai_operations` (log of each call: operation, prompt version, status, failure detail, tokens; no secrets).
- **Integrity:** UUID PKs, FKs with deliberate `on delete` rules, `unique(user_id, local_date)`, status enums / check constraints (`end > start`, duration > 0), `created_at`/`updated_at`, indexes on `(user_id, date)` and reminder `(status, scheduled_for)`.
- **History:** current task status is derived from / consistent with `task_events`; any plan is reconstructable from its revisions.
- Not over-engineered: habits, calendar sync, analytics tables are deferred.

## 7. Authentication approach

- **Supabase Auth**, cookie sessions through `@supabase/ssr` (server client in RSC/route handlers, middleware/proxy refreshes tokens).
- Sign-in: email magic link and/or OAuth (Google) — **decision D3**.
- Verify with `supabase.auth.getUser()` server-side (not `getSession()`); a single `requireUser()` helper is the only way handlers obtain a user ID.
- RLS on every user-owned table (`user_id = auth.uid()`), plus explicit app-layer checks. Sign-ups restricted (invite/allow-list) because this is a personal app — **decision D3**.

## 8. Deployment architecture

- **Vercel** for the Next.js app; **Supabase** hosted project for DB/Auth. Separate Supabase projects for local/dev and production; preview deployments use the dev project.
- **Scheduled work** (reminders, end-of-day reports) via Vercel Cron → protected route handler (`CRON_SECRET` bearer check) → idempotent service functions. Hobby-tier cron limits may require a DB-driven "due reminders" sweep at coarse cadence — **decision D5**.
- Webhooks (Twilio status, etc.) verify signatures.
- Node runtime pinned via `engines` and `.nvmrc` (see D2). Security headers set in `next.config`. CI (GitHub Actions): lint, typecheck, unit, build; Playwright on PR.
- Structured JSON logging to stdout (Vercel logs); optional error tracker later.

## 9. Animation architecture

Single ownership rule: **each animation has exactly one owner library.**

- **GSAP** — orchestrated/spatial: route/page transitions, dashboard entrance sequence, timeline block movement and reorder (FLIP), replan transitions, layout changes, justified scroll effects. Loaded only in client components that need it, via `@gsap/react` `useGSAP` for cleanup; dynamic-imported for heavier sequences.
- **Anime.js v4** — isolated micro-feedback: checkmark/status icon draw, count/percentage value tweens, subtle badge pulses.
- **CSS transitions** — hover/focus/press.
- `lib/motion/`: `reduced-motion.ts` (single gate: `matchMedia('(prefers-reduced-motion: reduce)')`; when reduced, durations → 0 / state applied instantly, no travel), `tokens.ts` (durations, eases), thin wrappers (`useTimelineMotion`, `animateValue`). Components never call the libraries ad hoc.
- Constraints: animate `transform`/`opacity` only, never delay interaction (interruptible, ≤ ~300ms for feedback), no looping ambient motion, animation state never encodes data (the DB does).

## 10. Testing strategy

- **Vitest unit tests** (highest value): scheduling/replanning rules (no overlap, respects fixed items and deadlines, never moves completed tasks, no invented hours), Zod schemas, AI output validators and retry logic (using recorded fixtures and a fake Claude adapter), report aggregation, reminder due-selection/idempotency, time/timezone helpers.
- **Integration:** repositories against a local Supabase (CLI/Docker), including RLS checks (user A cannot read user B).
- **Playwright E2E** on critical journeys: auth, briefing → plan, complete/skip/late, replan, reminder processing, report generation, history. AI is stubbed at the adapter boundary by an env-selected fake; a small, optional, manually-run live-Claude smoke test.
- **Quality gates** each phase: `lint`, `typecheck`, `test`, `build`. Reduced-motion and keyboard paths get e2e coverage.

## 11. Environment-variable strategy

- `.env.local` for local secrets (gitignored); `.env.example` committed with names only; production values in Vercel project settings.
- `src/config/env.ts` parses `process.env` with Zod at startup, with **separate server and public schemas**; failing fast with a clear message. Server env module imports `server-only`.
- Only `NEXT_PUBLIC_*` values reach the browser, and only non-secrets (Supabase URL, anon/publishable key, app URL).

| Variable                                                          | Scope                   | Phase       |
| ----------------------------------------------------------------- | ----------------------- | ----------- |
| `NEXT_PUBLIC_SUPABASE_URL`                                        | public                  | 1–2         |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or publishable key)              | public                  | 1–2         |
| `NEXT_PUBLIC_APP_URL`                                             | public                  | 1           |
| `SUPABASE_SERVICE_ROLE_KEY`                                       | server only, jobs/admin | when needed |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`                            | server only             | AI phase    |
| `RESEND_API_KEY`, `EMAIL_FROM`                                    | server only             | reminders   |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | server only             | reminders   |
| `CRON_SECRET`                                                     | server only             | scheduling  |

## 12. Missing production requirements (all, since project is empty)

Scaffold and toolchain; CI; env validation; migrations and RLS; auth and route protection; structured logging; rate limiting for AI endpoints (DB-backed counters or Upstash — decision D6); security headers/CSP; error boundaries and loading/empty/error states; a11y baseline; backup/restore note for Supabase; deploy runbook.

## 13. Potential architectural risks

1. **TypeScript 7 (native compiler)** is the current `latest`; ecosystem tools (Next type-checking, typescript-eslint, Vitest/Playwright transforms) may lag → D1.
2. **Node 26 locally** is a non-LTS release; Vercel supports specific majors → D2.
3. **Anime.js v4 and GSAP** are both DOM-mutating; the single-owner rule and per-element ownership must be enforced in review.
4. **Timezones/"day" boundaries:** store user timezone; compute `local_date` server-side; never trust client clock for plan logic.
5. **Serverless AI latency:** planning calls can be slow; use route-level `maxDuration`, explicit loading/timeout states, and idempotent retries.
6. **Vercel Cron granularity** on lower tiers vs minute-level reminders → D5.

## 14. Phase roadmap (proposed)

| Phase | Scope                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| 0     | Reconnaissance, architecture, README (this)                                                                             |
| 1     | Scaffold: Next.js, TS, Tailwind, ESLint/Prettier, Vitest, Playwright config, env contract, CI, design tokens, app shell |
| 2     | Supabase: migrations, RLS, generated types, repositories, auth (sign-in, session, route protection)                     |
| 3     | Domain core: task model, scheduling engine, validation, unit tests (no AI)                                              |
| 4     | Briefing capture + AI plan generation pipeline (prompts, Zod, business-rule validation, retry, logging)                 |
| 5     | Today dashboard: "what now / next", timeline, task actions (complete/skip/late/add/reprioritize)                        |
| 6     | Replanning with plan revisions and history preservation                                                                 |
| 7     | Motion system (GSAP + Anime.js) applied to dashboard                                                                    |
| 8     | End-of-day reports + history views                                                                                      |
| 9     | Reminders: Resend email, Twilio WhatsApp, cron processing                                                               |
| 10    | Hardening: e2e suite, a11y audit, rate limiting, security headers, deploy runbook                                       |

Future (explicitly not planned yet): weekly/monthly analysis, growth tracking, smart nudges, calendar integration, voice briefing, focus mode, habit tracking.

## 15. Phase 1 outcomes and provisional decisions

Applied in Phase 1 (the owner had not yet answered the Phase 0 questions, so the recommendation in each case was used; revisit any of them):

- **D1** TypeScript pinned to **6.0.x** (7.0 is `latest`; tooling not yet verified against it).
- **D2** Node **24** in `.nvmrc`, `engines >=22`. Local Node 26 also works.
- **D4** **npm** (matches the requested `npm run …` scripts).
- ESLint is 9.x: `eslint-config-next` 16 peers `>=9`, and npm resolved 9.39.
- Tailwind 4 CSS-first (`src/app/globals.css`); system font stack to keep builds offline-safe.
- **Health:** `GET /api/health` returns `{status, timestamp, checks:{database}}` only. The probe calls Supabase's unauthenticated `/auth/v1/health` with the anon key, so it works before any schema exists. It proves reachability of the Supabase project, not table access. 200 = ok/degraded (unconfigured), 503 = down.
- **Auth boundary:** `(app)` layout calls `requireUser()` (verified `getUser()`), redirecting to `/login`. `/login` is a placeholder until Phase 2. There is no dev bypass. The session-refresh proxy is also Phase 2.
- **Errors:** `AppError` hierarchy in `src/server/errors` (validation 400, auth 401, not found 404, external 502, internal 500); `withErrorHandling` wraps route handlers; causes are logged, never returned.
- **Logging:** JSON lines via `src/server/logging`; sensitive keys and secret-shaped strings redacted; `console` is lint-banned elsewhere.
- **Motion:** `src/lib/motion` (tokens, single reduced-motion gate, lazy GSAP/Anime loaders). `@gsap/react` is deferred until the motion phase.
- CI: `.github/workflows/ci.yml` (lint, typecheck, unit, e2e). No build step is separate because e2e builds.

## 16. Phase 3 — database and application state

Phase 3 turned the Phase 2 visual shell (mock data in `src/mock/`, deleted this phase) into a
real, persisted application: Postgres via Supabase is now the source of truth for days,
briefings, tasks, task history and a minimal plan/revision thread, and Today reads and
writes it through a real authenticated session. No AI, reminders, cron or reports —
those remain future phases.

### Why authentication had to be built here

Section 7 above ("Phase 1 outcomes") said auth was a Phase 2 placeholder. Phase 2 then
stayed mock-data-only and never returned to it, so by the start of Phase 3 the app had only
ever built the **guard** (`requireUser()` redirecting to `/login`) — nothing actually issued
a session. Phase 3 cannot demonstrate "an authenticated user's data persists" without one,
so the smallest fix that unblocks the phase without redesigning anything was added:

- **Passwordless email sign-in** (`supabase.auth.signInWithOtp`), a real form at `/login`
  (`src/app/(auth)/login/`), and `/auth/callback` (`src/app/auth/callback/route.ts`)
  exchanging the PKCE code for a session.
- **`src/proxy.ts`** (Next.js 16 renamed `middleware.ts` → `proxy.ts` mid-phase; this repo
  uses the new convention) refreshes the session cookie on every request — Server
  Components can read cookies but not write them, so without this a long-lived session
  would eventually go stale.
- A minimal **sign-out** control in the sidebar (`src/components/layout/app-shell.tsx`).
- Open sign-up: anyone who can receive email at an address can create an account. There is
  no invite/allow-list — see the open decisions below.

### Magic-link constraints (current behavior)

- **A magic link only works in the browser context that requested it.** The link Supabase
  emails by default comes back to `/auth/callback` as a PKCE `?code=`. Exchanging it needs a
  `code_verifier` that was stored in a cookie when the sign-in was requested, so opening the
  link from a mail app that launches a _different_ browser (or from another device) fails with
  `AuthPKCECodeVerifierMissingError: PKCE code verifier not found in storage` and lands on
  `/login?error=auth`. This is how PKCE is designed to behave, not a bug that can be patched
  around without weakening it.
- **The cross-browser fix is written but blocked.** `src/app/auth/confirm/route.ts` verifies a
  `token_hash` with `verifyOtp` (no cookie needed, so it works from any browser or device), and
  `supabase/templates/magic_link.html` is the matching email template. Pushing that template
  is refused by Supabase: _"Email template modification is not available for free tier
  projects using the default email provider."_ The `[auth.email.template.magic_link]` block in
  `supabase/config.toml` is therefore commented out on purpose, and `/auth/confirm` is
  **inactive** — nothing links to it. Its `next` parameter is restricted to same-site paths
  (`src/lib/validation/redirect.ts`), so it is safe to leave deployed.
- **Future path:** configure a custom SMTP provider (Resend is already in this project's
  later-phase stack) or upgrade the plan, then uncomment the template block and run
  `supabase config push`. Until then, request the link and open it in the same browser.
- **Rate limits** on this project's default email provider (from its pulled config): 2
  magic-link emails per hour project-wide and 1 per minute per address. Exceeding either
  surfaces as `over_email_send_rate_limit` (shown to the user as "A required upstream service
  failed.").

### Schema

One migration, `supabase/migrations/20260922120000_init_schema.sql`, is the entire schema.
Every table carries its own `user_id uuid references auth.users(id)` — **not** a second
identity system; `auth.users.id` is the one stable key everything hangs off.

| Table            | Purpose                                             | Key constraints                                                                                                              |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `profiles`       | Holds `timezone`; nothing Supabase Auth already has | PK = `auth.users.id` (1:1, not a second credential store)                                                                    |
| `days`           | One row per (user, calendar date)                   | `unique (user_id, local_date)` — the actual idempotency guard, not app code                                                  |
| `briefings`      | Append-only briefing text per day                   | insert-only; "current" = most recent row by `created_at`                                                                     |
| `tasks`          | The core scheduled item                             | `status` ∈ upcoming/completed/skipped/late; `scheduled_end > scheduled_start`; `completed_at` set iff `status = 'completed'` |
| `task_history`   | Append-only status-change audit log                 | one row per creation + per transition; never updated                                                                         |
| `plans`          | The planning thread for a day                       | `unique (day_id)` — at most one plan per day                                                                                 |
| `plan_revisions` | Version marker within a plan                        | `unique (plan_id, revision_number)`                                                                                          |

Relationships: `days 1—1 plans 1—N plan_revisions`; `days 1—N tasks`; `tasks 1—N task_history`; `days 1—N briefings`. Tasks reference `day_id` directly (not `plan_id`/`plan_revision_id`) — see "plan/revision semantics" below for why.

### RLS strategy

Every table has RLS enabled and policies scoped `to authenticated using/with check ((select auth.uid()) = user_id)` (the `select` wrapper is Supabase's documented pattern so the planner evaluates `auth.uid()` once, not per row). `task_history` and `plan_revisions` denormalize `user_id` from their parent row specifically so their policies are a direct column check rather than a join — cheaper and harder to get wrong. There is **no service-role client anywhere** in the app; every table is reachable exactly to its owner through the anon-key, cookie-scoped client already established in Phase 1 (`src/server/db/supabase-server.ts`).

Two SQL functions (`create_task_with_history`, `change_task_status`, bottom of the migration) exist purely for **atomicity** — a task write and its history row must both happen or neither does. Both are `security invoker` with `search_path = ''` and fully qualified references: they run with the caller's own privileges and are just as RLS-bound as a direct table write, so they grant no privilege escalation. `change_task_status`'s `UPDATE ... WHERE status = 'upcoming'` is also where the "resolved tasks are terminal" rule is enforced a second time, at the database layer — see "task lifecycle" below.

**RLS is defined and documented but not live-verified.** This sandbox has no Docker/Supabase CLI, so nothing here has run against a real Postgres instance. `supabase/tests/rls_isolation.sql` is a from-scratch isolation check (creates two users, impersonates each via `request.jwt.claims`, asserts user B can't read/write/RPC user A's rows) — run it with `supabase start && supabase db reset` and the `psql` command documented at the top of that file. Treat both the migration and this test as reviewed-but-unverified until someone runs them for real.

### Task lifecycle

Persisted status is a 4-way enum: `upcoming | completed | skipped | late`. **`current` is deliberately not persisted** — the Phase 2 UI's fifth status is derived at read time (`src/domain/tasks/derive-status.ts`): an `upcoming` task whose `[scheduled_start, scheduled_end)` window contains `now` displays as `current`; everything else displays exactly as stored. Storing `current` as real state would need a background job to expire it again once the window passed, and scheduled jobs are explicitly out of this phase's scope — deriving it avoids that entirely, and matches how Phase 2's mock day already behaved (a snapshot computed once per load, not continuously re-derived).

`completed`, `skipped` and `late` are **resolved/terminal** (`src/domain/tasks/transitions.ts`). The only legal transition is `upcoming → {completed, skipped, late}`; nothing else is allowed, enforced identically in three places for defense in depth:

1. `src/domain/tasks/transitions.ts` — the pure rule, unit-tested directly.
2. `src/server/services/tasks.ts` — checks the task's actual current status before ever touching the database, so the user gets a clear "already resolved" message instead of a generic failure.
3. `change_task_status()`'s SQL `WHERE status = 'upcoming'` — the rule holds even if step 2 were ever bypassed or called incorrectly.

A user-created task's `source` is always `'user'`; the column exists (rather than being added later) so a future AI planner can tell its own rows apart from the user's and never silently rewrite or delete one it didn't create.

### Task history

Every creation and every status change appends a `task_history` row (`previous_status` null for creation) inside the same atomic RPC as the mutation itself — never a separate, potentially-inconsistent write. It is not surfaced in the UI yet and there is no analytics on top of it; it exists so a future report/replan phase has a trustworthy log to read instead of needing to infer history from current state.

### Plan/revision semantics

A `plan` is the planning thread for a day (`unique (day_id)`); a `plan_revision` is a version marker inside it. `resolveCurrentDay` → `ensurePlan` creates exactly one revision (`revision_number = 1`, `source = 'system'`) the first time a day is initialized, establishing the `Day → Plan → Revisions` chain a future AI-replanning phase can extend by inserting revision 2, 3, ... rather than mutating revision 1 — satisfying "replanning must never destroy the previous plan" from day one, before there's anything to replan yet.

**Deliberately not built:** revisions hold no task snapshot, and tasks reference `day_id` directly, not `plan_id`/`plan_revision_id`. Nothing in this phase produces or consumes a snapshot — inventing that shape now would be guessing at a future phase's actual needs, which the phase brief explicitly warned against ("do not create speculative tables for every future feature").

### Timezone strategy

A user's timezone is **reported by their browser and never guessed by the server.** `profiles.timezone` holds the IANA name, and a `profiles` row exists _only once_ a browser has reported one — so "no profile" means "timezone unknown". `src/domain/days/timezone.ts` resolves "today" as `Intl.DateTimeFormat('en-CA', { timeZone }).format(now)` — never `new Date().toISOString().slice(0, 10)`, which is always UTC's date and wrong for most users for hours of every day. `Intl` is built into Node/browsers, so this needed no new dependency (`@date-fns/tz` was in the Phase 0 plan but wasn't needed).

While the timezone is unknown the server creates **nothing**: `findCurrentDay` (`src/server/services/day.ts`) returns `null`, `getTodaySnapshot` returns `{ kind: "needs-timezone" }`, and the Today page renders `TimezoneSetup` (`src/components/layout/timezone-setup.tsx`), which reports the browser's zone through `syncTimezoneAction` and then calls `router.refresh()`. Mutations that need a day (`resolveCurrentDay`) fail with a `ValidationError` in that window instead of filing under a guess. Later changes (e.g. travel) are picked up by `timezone-sync.tsx` in the app shell, cached per browser in `localStorage`. There is no settings UI.

**Why it works this way.** This originally created a profile on first read with the column default `'UTC'` and immediately created a day from it, before the page carrying the browser-side sync had even reached the browser. The sync then changed the timezone, and the next request computed a different date — leaving a stray extra `days` row whenever UTC's date and the user's differed (for as many hours of every day as the user's UTC offset — about 5.5 in Calcutta, and 7 or 8 in Los Angeles depending on daylight saving time). `days_user_date_unique` was never violated: two different dates are two legitimate rows. The defect was persisting a day under a timezone the system knew was a placeholder. The `'UTC'` default on the column remains in the schema but is no longer relied on — every profile is now written with an explicit, browser-reported value. No migration was needed.

### Data-access architecture

```
UI (features/dashboard) → Server Action (features/dashboard/actions.ts, "use server")
  → service (server/services/*.ts: auth + Zod validation + domain checks)
    → repository (server/db/repositories/*.ts: typed Supabase calls only)
      → Postgres (RLS-enforced)
```

Repositories are the only files that import the Supabase client's query builder directly; nothing above them constructs a query. Every repository function takes the request-scoped client as a parameter (dependency injection) rather than creating its own, which is what makes the service-layer tests possible without a live database (`src/server/services/tasks.test.ts` etc. mock the repository functions, not the SQL). `src/server/errors/action.ts` (`runAction`) is the Server-Action counterpart of Phase 1's `withErrorHandling`/`errorResponse` — same `AppError` classification, logging and redaction, returned as `{ ok, data | error }` instead of a `NextResponse` because a Server Action's thrown errors don't reach the browser as a normal HTTP response.

`src/server/db/database.types.ts` is a **hand-written** stand-in for `supabase gen types typescript` (no CLI in this sandbox to run it) — keep it in sync with the migration by hand until the project is linked, then regenerate it for real.

### Important invariants

- A user has at most one `days` row per calendar date — enforced by `days_user_date_unique`, not application logic; `getOrCreateDay`'s upsert is what makes opening Today from two tabs at once safe.
- A day has at most one `plans` row — `plans_day_unique`.
- A task's `day_id` is **never** taken from client input — every mutating action re-resolves "today" server-side (`resolveCurrentDay`), so a stale client value (or a spoofed one) can't misfile a task, and a session that crosses real midnight correctly starts filing into the new day.
- `completed_at is not null` iff `status = 'completed'` — a CHECK constraint, not just convention.
- No mutation is optimistic: the UI updates local state only from what an action actually returned, never speculatively, so there is nothing to roll back on failure (`src/features/dashboard/dashboard-view.tsx`).

### Testing reality check

Everything that doesn't need a live Postgres instance is covered by the unit suite (`npm test`): `src/domain/**`, `src/lib/validation/**`, the repositories against a recording fake client, and the service layer against mocked repositories/auth.

What has **not** been automated or executed:

- **Cross-user RLS isolation has not been executed against the live project.** `supabase/tests/rls_isolation.sql` (two fixture users; asserts user B can't read or write user A's rows) has never been run. It is syntactically valid (parsed with PostgreSQL's own grammar) but that is all that has been established. It needs a local `supabase start` stack (Docker) and `psql`; it is deliberately _not_ run against the hosted project because it inserts fixture rows into `auth.users`. What _was_ verified live, with a real session and the anon key: an anonymous caller cannot execute either mutation RPC, cannot read or write any table, and the signed-in user's own create/complete/skip flow persists and is stable across refreshes.
- **The persisted-Today E2E (`tests/e2e/persisted-today.spec.ts`) remains `test.skip`.** It needs a real authenticated session, and the only sign-in path is a magic link delivered by real email. There is no password login or dev bypass, by design. Automating it needs either a local Supabase stack with a test inbox (Inbucket/Mailpit) or a session seeded via the Admin API — the latter must match the project's auth flow type (PKCE `?code=` vs implicit) that `/auth/callback` actually handles. The same steps were performed by hand against the hosted project.

## 17. Open decisions (still need approval)

- ~~**D3 Auth method**~~ — resolved this phase: passwordless email magic link, open sign-up (see "Why authentication had to be built here" above).
- **D3b Access control:** open sign-up today — anyone with an email address can create an account. Add an invite/allow-list before this is genuinely "personal."
- **D8 RLS/E2E verification:** cross-user RLS isolation is not executed against the live project, and the persisted-Today E2E stays skipped because it needs a real authenticated email session (see "Testing reality check"). Run `supabase/tests/rls_isolation.sql` on a local stack and choose an E2E session strategy before treating either as verified.
- **D9 Email delivery / cross-browser magic links:** the `/auth/confirm` + template fix is blocked by Supabase's free-tier default email provider. Choose custom SMTP (e.g. Resend) or a paid plan, then enable the template (see "Magic-link constraints").
- **D5 Scheduling:** Vercel Cron on current plan vs external trigger (e.g. Supabase pg_cron/Edge) for minute-level reminders.
- **D6 Rate limiting:** Postgres-backed counters (no new service) vs Upstash Redis.
- **D7 Claude model:** default model for planning and whether a cheaper model handles reports.
