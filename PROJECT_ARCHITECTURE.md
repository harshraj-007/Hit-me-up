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

> **Numbering note (added in Phase 7):** the table above is the Phase 0 _proposal_. Execution diverged from it — Phase 4 became the deterministic live day (with 4.1/4.1b), Phase 5 became AI planning, Phase 6 became Web Push notifications and automation (6.1–6.5), and **Phase 7 is end-of-day intelligence** (this document's "Phase 7" section). The per-phase sections below are the record of what was actually built; use them, not this table, for anything already shipped. "Reminders: Resend email / Twilio WhatsApp" (the table's Phase 9) and "history views" remain unbuilt.

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

Two SQL functions (`create_task_with_history`, `change_task_status`, bottom of the migration) exist purely for **atomicity** — a task write and its history row must both happen or neither does. As first written (Phase 3) both were `security invoker`; Phase 4 makes them `security definer` and removes all direct write privileges on `tasks`/`task_history` — see "Important invariants" for why, and how they stay safe. `change_task_status`'s `UPDATE ... WHERE status = 'upcoming'` is also where the "resolved tasks are terminal" rule is enforced a second time, at the database layer — see "task lifecycle" below.

**RLS is defined and documented but not live-verified.** This sandbox has no Docker/Supabase CLI, so nothing here has run against a real Postgres instance. `supabase/tests/rls_isolation.sql` is a from-scratch isolation check (creates two users, impersonates each via `request.jwt.claims`, asserts user B can't read/write/RPC user A's rows) — run it with `supabase start && supabase db reset` and the `psql` command documented at the top of that file. Treat both the migration and this test as reviewed-but-unverified until someone runs them for real.

### Task lifecycle

Persisted status is a 3-way enum: `upcoming | completed | skipped`. **`current` and `late` are derived from the clock and never stored** (`src/domain/tasks/temporal.ts`, `deriveTaskTemporalState`, the only place the clock becomes a state). Intervals are half-open, `[scheduled_start, scheduled_end)`:

| Stored                  | Clock / flag      | Shown as            |
| ----------------------- | ----------------- | ------------------- |
| completed / skipped     | any               | completed / skipped |
| upcoming, `unscheduled` | any               | unscheduled         |
| upcoming                | now < start       | upcoming            |
| upcoming                | start ≤ now < end | current             |
| upcoming                | now ≥ end         | late                |

So at the exact end of a task the next back-to-back task is current and the first is late; two tasks are never current together. An overdue task is still `upcoming` in storage, so it stays completable, skippable, reschedulable and replannable. There is no "mark late" mutation (Phase 3 had one and stored a terminal `late`; migration `20260924120000` normalises any such rows back to `upcoming` and logs each as a `system` history event).

`completed` and `skipped` are **terminal** (`src/domain/tasks/transitions.ts`); the only status change is `upcoming → completed | skipped`, enforced in the domain, in `src/server/services/tasks.ts`, and in `change_task_status()`'s `WHERE status = 'upcoming'`.

**Progress** (`calculateDayProgress`) is `completed / (total − skipped)`: skipped tasks neither count as done nor drag the ratio down; late and unscheduled tasks stay in the denominator. With nothing countable the ratio is `null` and the UI hides it.

`source` is `user` or `planner`. `schedule_locked` is set when the user moves a task by hand; `unscheduled` is set when a replan could not fit it (its times are kept, it is never deleted or shortened, and it holds no slot).

### Task history

`task_history` is append-only (no UPDATE/DELETE policy). Each row has an `event`: `created`, `status_changed`, `rescheduled` or `replanned`. Schedule events also record previous/new start, end and unscheduled flag, plus the `revision_id` of the plan revision they belong to (a CHECK requires all of these). Every write happens inside the same RPC as the change it describes, so a task update and its history commit or fail together. Nothing is written for derived state (current/late), clock ticks, refreshes or renders.

### Plan/revision semantics

A `plan` is the planning thread for a day (`unique (day_id)`); a `plan_revision` is a version marker in it. `ensurePlan` creates revision 1 (`system`) with the day. Phase 4 extends it, append-only:

- `reschedule_task()` — a manual move that actually changes the window appends a `user` revision; re-saving the same window appends nothing.
- `apply_replan()` — a replan with at least one real change appends exactly **one** `system` revision, however many tasks moved; an empty or no-op change list appends none, so repeated identical replans don't accumulate revisions.

Revisions still hold no snapshot; what changed is the set of `task_history` rows pointing at the revision.

### Deterministic replanning (Phase 4)

`replanRemainingDay` (`src/domain/scheduling/replan.ts`) is pure: no I/O, no clock of its own, no randomness, same input → same output. It runs only when the user clicks **Replan remaining day** — never on a tick, page load, completion or render.

- **Movable** = unresolved, `source = 'planner'`, not `schedule_locked`, not `kind = 'fixed'`, not current right now. Everything else is an obstacle or history: completed/skipped work, user tasks, manually moved tasks, fixed tasks and the current task are never moved or deleted.
- **Window** = `[max(now rounded up to the minute, local day start), local day end)`, from `dayBoundsUtc(localDate, timezone)` — real local midnight to next local midnight, DST-safe (23/24/25-hour days), converted to UTC. No working-hours setting exists.
- **Order** = priority (high → low), then earlier `due_at`, then original start, creation time, id. Each task goes at its **full duration** into the earliest gap that fits and meets its `due_at`; nothing is placed in the past or on top of anything else.
- **Doesn't fit** → returned as `unscheduled` (`no-room`, `past-due-date`, `day-over`), persisted with `unscheduled = true`, shown in a "Couldn't fit today" list. User-task overlaps are reported (`detectScheduleConflicts`), never auto-resolved.

`replanToday` computes the plan server-side from a fresh read and hands the changes to `apply_replan()`, which re-checks ownership, day, `status = 'upcoming'`, `source = 'planner'`, `not schedule_locked`, and that each row still matches the state the plan was computed from (else `40001`, whole replan rolls back and the user is asked to retry). Because Phase 3 creates only user tasks, replan is report-only on real accounts until planner-sourced tasks exist.

### Planning days: cross-midnight tasks and future-day planning (Phase 4.1)

A task belongs to one **planning day** for life: `tasks.day_id` never changes, and there is no operation that moves a task to another day. Two separate features sit on top of that:

- **Cross-midnight** — the window may run past midnight and the task stays on its day. Formal rule (`domain/scheduling/window.ts`, repeated in SQL): `dayStart <= start < dayEnd`, `end > start`, `end - start <= 24h` (also a CHECK, `tasks_duration_max`). Thu 23:30 → Fri 01:00 and Thu 23:30 → Fri 23:30 are valid; Thu 23:30 → Sat 00:00 and Fri 00:00 → Fri 01:00 (for a Thursday task) are not. `current`/`late`/`unscheduled` are derived from instants exactly as before (half-open `[start, end)`), so nothing changes for a task that crosses midnight.
- **Future-day planning** — a task can be planned for any local date from today through today + 365, inclusive (366 dates; `domain/days/planning-day.ts`). No past dates. The client names only a **date**; the server resolves the day row, so a client-supplied day id has no authority.

**`ensure_day(date default null)`** is the only application write path that creates a day, its plan and revision 1 (SECURITY DEFINER, empty `search_path`, authenticated-only). The timezone always comes from the caller's profile and is **frozen on the day row when it is first created**: an existing day is never re-stamped, so if the profile timezone changes later, days that already exist keep their original zone (new days use the new one). All boundaries, wall-time conversion (`wallTimeToUtc`) and display for a day use that day's `days.timezone` — never the browser's zone and never the current profile zone. Viewing a future date only reads; a day is created when an action needs it (adding a task).

**Spillover** (`listSpilloverTasks`) is the previous day's unresolved, scheduled tasks whose window reaches into the current day. It is shown under "From <date>", occupies time for conflict detection, planning and "time left", and is excluded from the current day's progress. There is no general carry-over of overdue tasks.

**Rescheduling moves a task; it never resizes it.** A task's duration is not a stored value — it is `scheduled_end - scheduled_start` — and a manual reschedule preserves it: the caller supplies only the **new start** and the end is derived as `new_end = new_start + original_duration` (real elapsed time, so a 90-minute task stays 90 minutes across a DST change). A 90-minute task moved to 23:30 becomes 23:30 → 01:00 (+1 day) and a 120-minute one moved to 22:30 becomes 22:30 → 00:30; both stay on their planning day. It is enforced at every layer, not only in the UI: the reschedule dialog offers no end field; `rescheduleTaskInputSchema` is strict, so a supplied end, duration, owner or day id is _refused_ with an explanatory error rather than silently ignored; `validateReschedule` (domain) derives the end from the stored task and applies the planning-day, ≤ 24h and not-already-over rules; and `reschedule_task()` in SQL rejects any window whose length differs from the stored one (2 ms tolerance), so a direct call to the RPC cannot resize a task either. A task the user already moved by hand (locked) can be moved again and stays locked; completed and skipped tasks cannot be moved; the duration used is the one stored _now_, so a stale screen cannot change it. Changing a task's length is deliberately not part of rescheduling (no editing feature exists yet).

**Replan** takes a `dayId` and moves only that day's own eligible planner tasks; anything from another day (including spillover) is an obstacle. Today's window is `[max(now, dayStart), dayEnd)`; a future day is replanned over its whole local day; a future day with no row is a no-op. The planner never creates a cross-midnight placement.

**Known limitation — Postgres vs. JavaScript timezone data.** Day bounds are computed in two places: the application (Node/browser `Intl`, for validation and display) and Postgres (`local_date::timestamp at time zone tz`, the authoritative re-check inside the RPCs). They can disagree in rare cases: (1) on the single day a year where a zone's _midnight_ is ambiguous (a fall-back that repeats 00:00 — e.g. `America/Havana`, `Atlantic/Azores`), Postgres takes the later occurrence and JavaScript the earlier; (2) where the two tz databases differ on _future_ rules (measured: British Columbia in winter 2026/27 and 2027/28). Measured across all 525 zones × every day of 2026–2027, 386 of 383,250 days differ (four zones). **The stricter check wins**: a window either side rejects is rejected, so at worst a user sees "start must be inside the planning day" in the first or last hour of one of those days. No invariant is weakened and there is no cross-user or security effect. Deliberately left as is; revisit (e.g. by taking bounds from Postgres) only if real usage shows it matters.

### Future product direction: "Replan my day" with AI (NOT built)

No AI exists in the product yet and none of it is implemented in Phase 4.1. The intended behavior once an AI integration exists: **"Replan my day"** offers two choices — the existing **manual, deterministic replan** (`replanRemainingDay`) and an **AI-assisted replan**. The AI option is expected to be most useful when there are roughly **four or more unresolved tasks**, where ordering and fitting them by hand is tedious; with fewer, the deterministic replan is usually enough. The AI is an advisor, not an authority: it can only _propose_ a schedule, and the proposal goes through exactly the same path as any other change — parsed, validated against the same domain invariants (never move completed/skipped or user-created or locked tasks, preserve durations, stay inside the planning day and the 24h rule, no overlaps, nothing scheduled in the past, nothing silently dropped) and applied only through the existing server-side write path (`apply_replan`, one revision, atomic, ownership-checked). It must never bypass server-side validation or receive any privilege the deterministic planner lacks. Until then, planner-sourced tasks do not exist, so replan is report-only on real accounts (see Known limitations).

#### Phase 5.0: AI contracts and deterministic validation (pure domain only)

Phase 5.0 adds only the provider-independent foundation, in `src/domain/ai-planning/` (transport schemas in `src/lib/validation/ai-planning.ts`). There is **no AI provider, no API call, no voice, no UI, no table, no RPC change and no persistence**; nothing here can write to the database.

- **AI output is untrusted; domain validation is authoritative.** A model can only produce a `PlanProposal` (`move` or `unschedule` changes, nothing else). Zod (`parseRawProposal`) checks the _shape_ only; `validateProposal` decides everything else, using the server's own snapshot (`PlanningState`), not the model's context.
- **Alias-based task references.** The model sees `t1`, `t2`, … never database ids, user ids, notes or history. The alias → id map stays server-side; a UUID, a hallucinated alias or an alias from another context is `unknown_ref`. The context is an explicit allow-list (`buildPlanningContext`), covered by leak tests.
- **Duration is preserved.** A move carries only a new start (local wall time in the day's frozen timezone). The end is derived from the stored duration and the whole window is judged by the existing `validateReschedule` / `validateTaskWindow`. A model-supplied end or duration is rejected (`duration_changed`); `change_duration`, `create`, `delete`, etc. are `unsupported_change`.
- **Proposal eligibility is its own rule (`isAiMovable`).** Completed/skipped and locked tasks are never changed, and a proposal may only name an unresolved, non-`fixed`, not-in-progress task of the planning day being planned (another day's spillover is an obstacle). This is deliberately **not** `isAutoMovable`, which stays planner-only and belongs to the manual deterministic replan. Conflicts are found with `detectScheduleConflicts` on the schedule the accepted changes would produce; any remaining conflict keeps a result from being `valid`.
- **No mutation without confirmation (future).** `ValidationResult` is the only thing a later Apply step may consume, and only after explicit user confirmation and a server-side re-check. Typed and voice input will enter through the same `UserIntent` (`source: "typed" | "voice"`); voice is only a way to produce that text.
- **Persistence is not solved here.** `apply_replan` accepts only `source = 'planner'` tasks and is unchanged, so a validated AI proposal cannot yet be applied to a user-created task. That needs a dedicated, separately reviewed confirmation RPC (a later phase).

#### Phase 5.1: Anthropic provider adapter (provider boundary only)

`src/server/ai/` holds the provider layer: a `ProposalGenerator` port (`port.ts`), the only SDK-aware file (`anthropic.ts`), a static, versioned prompt and tool schema (`prompt.ts`), `AiError` (`errors.ts`), an in-memory fake for tests (`fake.ts`), and `generateParsedProposal` (`generate.ts`), which runs the provider payload through the Zod parser. One request produces one `ParsedProposal`; malformed output is not retried or repaired. The adapter never touches Supabase, repositories or RPCs, decides no movability or duration, and persists nothing; a build-time test (`boundaries.test.ts`) guards those imports. `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are optional and server-only (`getAiConfig`): without them AI reports "unavailable" and nothing else is affected. Prompts and completions are never logged. No proposal service, persistence, confirmation, apply path or UI exists yet, and no real API call is made by the test suite.

#### Phase 5.2: AI proposal generation service (read-only)

`generateAiProposal(rawInput, deps?)` in `src/server/services/ai-planning.ts` is the single entry point:

```
verified session → UserIntent (Zod, horizon-checked, server-stamped `submittedAt`)
→ read-only: planning day (viewDay, never ensure_day) → plan revision → own tasks + previous-day spillover
→ PlanningContext (aliases, allow-list, the day's frozen timezone) → ProposalGenerator port
→ Zod (parseRawProposal) → validateProposal → ValidationResult
```

- **Read-only.** No RPC, insert/update, proposal store, revision write or task write; a build-time test scans the service for write verbs and mutating repository functions. Only the new read accessor `getLatestRevisionNumber` (`repositories/plans.ts`) was added.
- **Revision before tasks.** `baseRevision` is read _before_ the tasks, so a plan change between the two reads makes the tasks newer than `baseRevision` and a future confirmation compares it as stale, never the reverse.
- **Second line behind RLS.** Rows that are not the caller's, or not from the expected day, are dropped before the context is built.
- **Errors.** Unauthenticated (`AuthenticationError`), invalid intent or no day (`ValidationError`), and provider failures (`AiError`: unavailable, timeout, rate limited, provider error, malformed response) are thrown; a proposal the validator refuses is a `ValidationResult`, not an error.
- **Manual replan is unchanged:** `apply_replan()`, planner tasks only. **AI proposals:** the pipeline above, now followed by human-confirmed apply (Phase 5.3, below). **Not built:** proposal storage and a UI/Server Action for either service.

#### Phase 5.3: human-confirmed AI proposal → atomic SQL apply

Human confirmation is the boundary between AI reasoning and database mutation — the AI is never given mutation privilege, and a Phase 5.2 `ValidationResult` is never treated as authorization. `confirmAiProposal(rawInput)` in `src/server/services/ai-confirmation.ts` sends a confirmed proposal through exactly one call to the new `confirm_ai_proposal` SQL function, which independently re-derives everything security-relevant from the CURRENT database state:

```
verified session → Zod (planningDate, baseRevision, ≤20 changes; taskId is a UUID, never
  trusted as authorization) → the day, resolved from planningDate (read-only, never created)
→ confirm_ai_proposal(day_id, base_revision, changes)   [SECURITY DEFINER, one transaction]
     re-checks: auth.uid() ownership on the TASK ROW itself · day_id = this planning day
       (excludes spillover structurally, not as a special case) · unresolved · unlocked ·
       not fixed · not in progress — the Phase 5.2 AI-movability rule, reimplemented in SQL
     derives: a move's end from the row's CURRENT stored duration (no end/duration parameter
       exists to trust) · re-checks the base revision · re-checks the resulting schedule for
       conflicts, including the previous day's spillover into this one
     writes (only if everything holds): every task update + one 'ai' task_history row per
       task (event 'rescheduled') + exactly one 'ai' plan_revisions row — all atomically;
       any failure aborts the whole call, so nothing is ever partially applied
→ re-read tasks, return the new revision number
```

- **Ref vs task_id.** A proposal's alias (`t1`, `t2`, …) is carried through only for display/audit; it is never resolved back to a task at confirmation time. Rebuilding the alias assignment fresh would be unsound — a task created or resolved between proposal generation and confirmation shifts every later alias with no error and no revision bump. `taskId` (what the trusted server itself resolved during Phase 5.2 generation, `ValidatedChange.taskId`) is the real identifier instead — the same shape `reschedule_task()` already accepts — and the database still independently re-verifies ownership and full current eligibility for it before touching it. See the migration header for the complete reasoning.
- **`source` is preserved.** The UPDATE never sets `tasks.source`; a user-created task stays `user` and a planner task stays `planner` — there is no branch that could convert one into the other. `task_history.source` and `plan_revisions.source` gained a third value, `'ai'`, specifically so a human-confirmed AI change is distinguishable from a manual `'user'` edit or the deterministic `'system'` planner (an additive, widened CHECK constraint — no new column, no new table).
- **Duration is preserved.** A move carries only `newStart`; there is no `newEnd` and no duration field at any layer (Zod, the RPC's parameter list, or its accepted JSON keys), so it cannot be smuggled in — this is structural, not merely checked.
- **Locking.** Both a confirmed move and a confirmed unschedule set `schedule_locked = true`, the same outcome `reschedule_task()` already produces for a real move: a human explicitly approved this placement, so the next automatic replan (`apply_replan()`, still planner-tasks-only and untouched) must not silently undo it.
- **Errors.** `AiConfirmationError` (`stale_revision` · `task_ineligible` · `conflict` · `invalid_proposal`) mirrors `AiError`'s `.reason` pattern from Phase 5.1; a missing, foreign, resolved, locked, fixed or in-progress task all surface as the same `task_ineligible`, deliberately — no cross-user existence is ever revealed. A malformed request is a `ValidationError`/`ZodError` before any database call.
- **Concurrency.** `base_revision` is checked once, atomically, alongside the per-row eligibility re-check — a real, single-session equivalent of "the schedule advanced between generation and confirmation" is exercised in the scratch SQL suite (see below); a true two-connection race was out of scope for that harness.
- **Not built (as of 5.3):** proposal storage. A UI and Server Actions were added in Phase 5.4, below.
- **Verification:** the RPC was exercised in a scratch embedded Postgres (kept outside the repo, like the Phase 4/4.1 scratch suites) covering ownership, alias/ref-vs-taskId resolution, stale revision, every ineligibility case, malformed/duplicate/oversized proposals, conflicts, atomicity (a valid change alongside an ineligible one applies neither), the concurrency equivalent above, direct-write lockdown, and that `apply_replan()`/`isAutoMovable()` are unchanged — plus a dozen SQL mutation-kill checks (removing the ownership check, the revision check, the lock/resolved/conflict/duplicate checks, trusting a supplied end time, allowing a source conversion, incrementing the revision per task, skipping history, and removing atomicity), each of which the suite caught.

#### Phase 5.4: voice as an input modality — and the first AI UI

Voice is an input modality, never a mutation authority. It produces text for a human to review, exactly like typing — nothing downstream of that review step knows or cares which one produced it. The canonical flow:

```
voice → transcript (live, in the browser) → user reviews/edits it
     → UserIntent(source="voice")                      ── identical to typed input from here on
     → generateAiProposal()   (Phase 5.2, unchanged) → persists a snapshot (Phase 5.5, below)
     → deterministic validation (Phase 5.0, unchanged)
     → human reviews the proposal (now resumable — Phase 5.5), presses Apply
     → confirmPersistedAiProposal()   (Phase 5.5, composes the unchanged Phase 5.3 RPC)
     → the existing atomic confirmation RPC
```

- **Transcription mechanism: the browser's own `SpeechRecognition`** (`src/lib/voice/speech-recognition.ts`), not a server-side provider. This was a deliberate choice, not the absence of one: it needs no new dependency, no server route, and — the significant part — no credential of any kind, because there is nothing to keep secret. Audio never becomes a value this codebase holds, sends, or persists; the browser transcribes it internally and this module only ever sees the resulting text. The trade-off, disclosed here rather than hidden: browser support varies, and on Chromium-based browsers the engine itself is cloud-based (Google's), outside this app's control — the same way it already is for anyone using that browser's built-in dictation anywhere else. An unsupported browser disables the voice button with an explanation; typing always works.
- **Raw audio never reaches Anthropic**, or anywhere at all: `src/server/ai/*` (the planning provider layer) has no knowledge of voice, microphones, or the browser, and the voice module has no audio `Blob`, `MediaRecorder`, or upload of any kind — both are structurally enforced by `src/lib/voice/boundaries.test.ts`, which scans the source rather than merely asserting behavior.
- **Mandatory transcript review.** Recording never submits anything on its own. `src/features/dashboard/ai-planning/flow-state.ts` is a pure state machine — `idle → recording → transcribing → transcript_review → generating → proposal_ready → confirming → applied`, with `error`/`cancel` reachable throughout — and `submit`/`confirm` are the only two transitions that call a Server Action, both requiring an explicit prior state (`transcript_review`, `proposal_ready`) that only a user action reaches.
- **Stale results can't land.** Every state carries an `epoch`; starting a new recording, cancelling, or resetting mints a new one, and an event tagged with any other epoch is dropped by the reducer. A transcription or a proposal that resolves after the user cancelled, or after a newer recording started, is simply ignored — never merged into current state, never silently applied.
- **The same pipeline, not a second one.** `use-ai-plan-flow.ts` calls the exact `generateAiProposalAction`/`confirmAiProposalAction` Server Actions (new in 5.4, but thin wrappers with no logic of their own — see `src/features/dashboard/ai-planning/actions.ts`) regardless of `source`; there is no voice-specific proposal schema, movability rule, or mutation path. A voice-sourced request is rejected by exactly the same deterministic rules as typed text (duration changes, locked/resolved/in-progress tasks, conflicts, …), because validation never looks at `source` at all.
- **Privacy/logging.** `transcript` and `audio` were added to the structured logger's key-based redaction (`src/server/logging/redact.ts`), alongside the existing `prompt`/`completion` from Phase 5.1. Nothing in the voice or AI-planning UI logs at all in normal operation; this is defense in depth for the logger itself.
- **No audio persistence, ever** — unchanged by Phase 5.5, below: nothing about raw audio or a voice session is stored, only ever the resulting text, and only once the user explicitly generates a plan from it.
- **The AI proposal review UI itself was new in this phase** (`src/features/dashboard/ai-planning/ai-plan-dialog.tsx`, opened from a "Ask AI" button next to "Add task"): neither a UI nor a Server Action for Phase 5.2/5.3 existed before 5.4, so this phase built the minimal shared version both input modes need, rather than voice having nowhere to go. Phase 5.5, below, makes the proposal it produces persistent and resumable.

#### Phase 5.5: persistent AI proposals + resumable, replay-safe confirmation

A generated proposal is now an immutable, persisted snapshot — "the AI proposed THIS against plan revision X" — not a live view of current state, and not confirmable through any path that lets a caller supply its own day/revision/changes. The canonical flow:

```
UserIntent → generateAiProposal() → deterministic validation (Phase 5.0/5.2, unchanged)
  → create_ai_proposal()            [new, SECURITY DEFINER] persists the snapshot, atomically
                                      superseding any earlier pending proposal for that day
  → { proposalId, understood, unresolved, validation }        ── returned, nothing applied yet

refresh/navigation → loadPendingAiProposal(planningDate) → the day's pending proposal (if any),
                      with a live isStale check — reconstructs the review UI, no AI call

user presses Apply → confirmPersistedAiProposal({ proposalId })
  → confirm_ai_proposal_by_id()     [new, SECURITY DEFINER] locks the proposal row, requires
                                      status='generated' AND validation_status='valid', reads
                                      day_id/base_revision/changes FROM THE ROW (never the
                                      caller), calls the UNCHANGED Phase 5.3 confirm_ai_proposal()
                                      in the SAME transaction, then marks the row confirmed
  → one atomic transaction: task mutation + history + revision + "proposal confirmed" together
```

- **Schema (`supabase/migrations/20260929090000_phase55_persist_ai_proposals.sql`):** one new table, `ai_proposals` — RLS enabled, `authenticated` has `SELECT` only (owner-scoped), zero direct INSERT/UPDATE/DELETE grants, all writes through three new SECURITY DEFINER RPCs (`create_ai_proposal`, `confirm_ai_proposal_by_id`, `discard_ai_proposal`) — the same posture `tasks`/`days`/`plans`/`plan_revisions` have had since 4.1b. `task_history.source`/`plan_revisions.source` already accept `'ai'` (Phase 5.3); nothing there changed.
- **`confirm_ai_proposal()` (Phase 5.3) is untouched, byte-for-byte.** `confirm_ai_proposal_by_id()` composes it — calls it directly, in SQL, in the same transaction — rather than duplicating or modifying it, so its entire existing test suite and scratch-SQL verification remain valid evidence for this path too.
- **Replay protection is the row lock, not a separate mechanism.** `confirm_ai_proposal_by_id()` locks the proposal row (`for update`) and requires `status = 'generated'` before doing anything; a second concurrent confirm of the same id blocks on that lock, then finds the row already `confirmed` and is refused. No idempotency table, no client-supplied nonce.
- **Atomicity.** Locking the row, calling the unchanged confirmation RPC, and marking the row confirmed all happen in one PL/pgSQL call = one transaction: if the inner call raises (stale revision, an ineligible task, a conflict, malformed input), everything — including the row lock and the status update — rolls back, and the proposal is left exactly as it was (still `generated`, confirmable again after a fresh check). "Proposal confirmed" and "tasks changed" cannot disagree.
- **Ref vs. `task_id`, unchanged from 5.3.** The stored `changes` column is the exact confirm wire shape (`ref`, `task_id`, `type`, `new_start`); `ref` is carried only for audit/display, never resolved back to a task — see the migration for why rebuilding aliases at confirm time is unsound.
- **`validation_status` is enforced in SQL, not only by a disabled Apply button.** `confirm_ai_proposal_by_id()` refuses to confirm anything whose stored `validation_status` isn't `'valid'`, even if `changes` happens to be non-empty (a `partially_valid` proposal can have real accepted changes a human hasn't approved as a whole).
- **One pending proposal per day, enforced by a partial unique index** (`ai_proposals_one_pending_per_day`), not application code. `create_ai_proposal()` atomically supersedes (discards) any earlier pending proposal for the day before inserting the new one.
- **Staleness is never stored.** Whether a resumed proposal is stale is a live comparison, at read time, between its `base_revision` and the day's current plan revision (`loadPendingAiProposal`) — there is no `stale` status and no background job to keep one honest. The SQL confirmation path re-derives the same fact independently regardless of what the UI displays.
- **The transcript is stored** (`ai_proposals.transcript_text`), deliberately — a resumed proposal needs to show what it was generated from without another AI call. It is owner-scoped by RLS like the rest of the row, and named so the existing "any key containing `transcript`" log-redaction rule (Phase 5.4) already masks it.
- **Voice/typed parity, unchanged.** One `source` column, reused from `IntentSource`; nothing in the persistence path branches on it.
- **UI (`src/features/dashboard/ai-planning/`):** `ai-plan-dialog.tsx`/`use-ai-plan-flow.ts` now accept a `resumedProposal` and start directly in `proposal_ready` when one exists (via `flow-state.ts`'s `initialVoicePlanStateFor`, a plain function, not a reducer transition — resuming is what the page start looks like, not something that happens in response to an event). `proposal-view.ts` is a small pure mapper so the review screen renders identically regardless of whether a proposal came from a fresh generation (in-memory, full `ValidatedChange` fidelity) or a resumed read (from `ai_proposals`, missing only the free-text `reason` per change). Cancelling a pending, persisted proposal calls `discardAiProposalAction` (fire-and-forget).
- **Old ephemeral confirm path kept, but no longer reachable from a Server Action.** `confirmAiProposal(rawInput: {planningDate, baseRevision, changes})` (Phase 5.3) still exists in `server/services/ai-confirmation.ts`, still fully re-validated in SQL, but its Server Action was removed — an unused Action is still a reachable endpoint, and the app's real confirmation path is now exclusively proposal-id-based, which also removes the surface for a client to supply a different `base_revision`/`changes` than what was actually generated.
- **Not built:** editing a proposal in place (the user regenerates instead), multiple simultaneous pending proposals, and any background job.

#### Phase 6.1: Web Push subscription infrastructure (user-facing lifecycle only)

A full Phase 6 recon (Web Push notifications + automation) preceded this phase and is not repeated here; only what Phase 6.1 actually built is documented below. **Phase 6.1 persists a browser's Web Push subscription and nothing else** — no reminder is ever scheduled, computed, or sent by this phase. It is deliberately the first slice of a larger design: subscription persistence first, delivery/automation later, so each slice can be verified independently.

```
Browser → PushManager.subscribe() (Phase 6.2+, service worker not built yet)
        → PushSubscription → normalizeSubscription() → {endpoint, p256dh, authKey}
        → registerPushSubscriptionAction() → registerPushSubscription() (service)
        → registerPushSubscription() (repository) → register_push_subscription() RPC
        → push_subscriptions row (owner = auth.uid(), never the client)

"Turn off on this device" → revokePushSubscriptionAction() → revokePushSubscription() (service)
        → revokePushSubscription() (repository) → revoke_push_subscription() RPC
        → push_subscriptions.revoked_at set (never deleted)
```

- **Schema (`supabase/migrations/20260929100000_phase61_push_subscriptions.sql`):** one new table, `push_subscriptions` — `id, user_id, endpoint (unique), p256dh, auth_key, created_at, last_seen_at, revoked_at`. No device name, browser/user-agent, IP address, notification content, VAPID material, or delivery state — those were explicitly scoped out of this phase. RLS enabled; `authenticated` has owner-scoped `SELECT` only; zero INSERT/UPDATE/DELETE grants to `anon`/`authenticated`; all writes go through the two RPCs below. **`service_role` is granted nothing here** — Phase 6.1 has no automation path, so the existing "no service-role client anywhere in this codebase" invariant (`src/server/db/supabase-server.ts`) is unbroken by this phase; the automation/delivery phase is what will finally use `SUPABASE_SERVICE_ROLE_KEY`, and only from a cron route, never a user-facing one.
- **Endpoint ownership, the one real design decision in this phase.** `endpoint` is globally unique per browser subscription, but it is just a string parameter to `register_push_subscription()` — nothing server-side can independently prove the caller's browser holds a live subscription for it. A naive upsert (`on conflict (endpoint) do update set user_id = excluded.user_id`) would let an authenticated user silently take over another user's still-active subscription by supplying their endpoint string. The upsert therefore only refreshes a conflicting row when it is the SAME caller re-registering (ordinary idempotency) or the row has already been explicitly revoked (a real "I no longer claim this" signal); an endpoint still actively owned by someone else is left untouched and the caller gets a clear `P0002` instead of a silent hijack. Enforced with a `WHERE` clause on `do update`, so Postgres itself is what refuses the takeover, not application code.
- **Revocation sets `revoked_at`, never deletes** — the same posture `ai_proposals` uses for `status = 'discarded'`. A missing, foreign, or already-revoked endpoint is the same silent no-op in every case (never reveals whether an endpoint exists or who owns it), mirroring `discard_ai_proposal`.
- **Multi-device is supported by construction**: no `unique(user_id)`, only `unique(endpoint)` — one user can hold many active subscription rows.
- **Client (`src/lib/push/push-client.ts`, `src/features/notifications/`):** pure, unit-tested helpers (`isPushSupported`, `urlBase64ToUint8Array`, `normalizeSubscription`, `getExistingSubscription`, `subscribeToPush`) are kept separate from the React hook (`use-push-notifications.ts`), the same split `speech-recognition.ts` uses relative to the AI-planning hook — this project has no React Testing Library, so hook orchestration itself is verified by inspection/e2e, not unit tests, matching how `use-ai-plan-flow.ts` is already handled. Notification permission is requested **only** from the "Enable notifications" button's own click handler (`src/features/notifications/notifications-control.tsx`, mounted in `app-shell.tsx`'s sidebar) — never automatically on page load. `getExistingSubscription`/`subscribeToPush` call `navigator.serviceWorker.getRegistration()`, not `.ready` — `.ready` never resolves without a registered worker and would hang the whole flow; `getRegistration()` resolves to `undefined` instead, which this phase treats as a normal, non-crashing `service_worker_unavailable` outcome. **No service worker exists yet** (`public/sw.js` is a later Phase 6 step), so `subscribeToPush` cannot fully complete today — the control correctly reports that honestly rather than hanging or crashing, and starts working with no code changes once the worker ships.
- **This device's subscription state is read from the browser, never the server.** `getExistingSubscription()`'s `pushManager.getSubscription()` is the source of truth for "does THIS device have an active subscription" — there is deliberately no read endpoint for it, keeping the repository to exactly two methods (`registerPushSubscription`, `revokePushSubscription`), no generic CRUD.
- **Authentication**: identical to every other mutation in this app — `requireUserForAction()` in the service layer, `auth.uid()` in the RPC; the client-facing Zod schemas (`src/lib/validation/push.ts`) are `z.strictObject`, so a client cannot smuggle a `userId` field through even if it tried — ownership only ever comes from the session.
- **Redaction**: `endpoint`, `p256dh`, and `auth[-_]?key` were added to the existing sensitive-key regex (`src/server/logging/redact.ts`) — none of the prior patterns happened to already match them. The raw browser `PushSubscriptionJSON` (`keys.auth`, not `authKey`) is never logged or passed through the application layers at all; `normalizeSubscription` converts it to `{endpoint, p256dh, authKey}` before it ever crosses a boundary.
- **Not built (later Phase 6 steps, not this one):** the service worker, VAPID key generation, `scheduled_notifications`/`notification_deliveries`, reconciliation/claiming, any cron route, and anything that sends an actual push notification. `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is declared (`src/config/env.public.ts`'s `getVapidPublicKey()`) but unset by default — "Enable notifications" is simply unavailable until a real key pair is generated, the same graceful degradation `ANTHROPIC_API_KEY` gets.

#### Phase 6.2: notification reconciliation + atomic due-notification claiming

Builds the database-backed scheduling layer only: a materialized, always-re-derivable cache of "what reminder should fire when" (`scheduled_notifications`), and one atomic system RPC that reconciles it against live tasks and then claims whatever is due. **No Web Push, no service worker, no delivery of any kind — that is Phase 6.3.** Nothing here sends a notification; it only prepares and atomically claims the work.

```
tasks (authoritative, unchanged)          reconcile_and_claim_notifications()
   │ scheduled_start (timestamptz)   →      [SECURITY DEFINER, service_role EXECUTE only]
   ▼                                        1. recover abandoned claims (lease expiry)
scheduled_notifications                     2. sync active rows to the task's CURRENT schedule
   (materialized cache, never a             3. cancel rows whose task is no longer upcoming
    second source of schedule truth)        4. create a fresh row for any new, in-horizon task
                                             5. claim whatever is due (FOR UPDATE SKIP LOCKED)
                                                  ↓
                                        POST /api/cron/notifications (CRON_SECRET-gated,
                                        Vercel Cron, every 1 minute) → Phase 6.3 (not built)
```

- **Schema (`supabase/migrations/20260930090000_phase62_scheduled_notifications.sql`):** one new table, `scheduled_notifications` — `id, user_id, task_id, day_id, kind ('task_reminder' only), fire_at, task_scheduled_start_snapshot, status, claimed_at, attempt_count, resolved_at, created_at, updated_at`. One terminal timestamp (`resolved_at`), not four (`sent_at`/`failed_at`/`canceled_at`/`expired_at`): every terminal status is mutually exclusive, so a single nullable column is the same information with less surface area — the same reasoning `ai_proposals.confirmed_at` (not `discarded_at`) already established. A partial unique index (`task_id, kind` where `status in ('scheduled','claimed')`) enforces "at most one active reminder per task" in the database, the same pattern as `ai_proposals_one_pending_per_day`; a terminal (resolved) row never blocks a future one. RLS enabled, owner-scoped `SELECT` for `authenticated` (for a future UI; nothing reads it yet), zero write grants to `anon`/`authenticated` — the table's only writer is the one RPC below.
- **The 10-minute offset and 24-hour horizon are pure UTC/instant arithmetic** — `fire_at = scheduled_start - interval '10 minutes'`, computed directly from the task's own `timestamptz` column. No new timezone conversion exists anywhere in this file: tasks already store absolute instants (Phase 4.1), so there is nothing to convert. The horizon (`scheduled_start >= now() and < now() + 24h`) only gates _creating_ a new row; an existing active row is kept in sync regardless of horizon (see below), so a reminder already created never goes stale just because its task is later pushed further out.
- **Reconciliation is scheduler-driven, not task-RPC-driven — by design, so `reschedule_task`/`apply_replan`/`confirm_ai_proposal_by_id`/`change_task_status` stay exactly as Phase 4/4.1/5.3/5.5 left them.** An active (`scheduled`) row is corrected in place every reconciliation pass whenever its `task_scheduled_start_snapshot` disagrees with the task's live `scheduled_start` — this is what makes "reschedule a task" eventually reconcile its pending reminder, without any task RPC needing to know a notification system exists. The cost is a bounded delay (up to one cron tick, i.e. ≤ 1 minute) between a reschedule and its reminder being corrected; a `claimed` row is deliberately left untouched by this sync (it is not currently claimable regardless of what its stale data says — see invariant below), and self-heals a tick after its claim lease expires, when reconciliation creates a fresh, correctly-scheduled row for it.
- **A `scheduled` row whose task is no longer `upcoming` (completed, skipped, or any future terminal status) is `canceled`.** This is a blanket `t.status <> 'upcoming'` check, not an enumerated list, so a new terminal task status introduced later needs no matching change here. A `claimed` row is left alone by cancellation too, for the same reason as reschedule-sync.
- **Claim lease + recovery**: a `claimed` row untouched for more than 5 minutes is assumed abandoned. If `attempt_count < 3` it is returned to `scheduled` (reclaimable on the very same reconciliation pass, since its `fire_at` is still due); once `attempt_count >= 3` it is marked `expired` — permanently given up on, never retried again. This is entirely a claim-lifecycle concern, not a delivery retry system (Phase 6.3's job): 6.2 only prevents a claim from being stuck forever.
- **Reconciliation and claiming are ONE function, ONE transaction** (`reconcile_and_claim_notifications`), in that exact order: recover → reschedule-sync → cancel → create → claim (`FOR UPDATE SKIP LOCKED`). This is what guarantees a notification reconciliation has just invalidated this cycle can never be claimed by the same cycle, and what makes two overlapping cron ticks safe — `SKIP LOCKED` partitions the claimable set between them instead of ever claiming the same row twice (verified with a genuine two-Postgres-connection test, not just a single-session simulation — see the Phase 6.2 verification report).
- **System-only RPC, not user-authenticated.** No `auth.uid()` check — there is no user session on the cron path — instead the function requires the JWT's own `role` claim to be `service_role` (`auth.role()`, real Supabase's own helper), checked explicitly inside the function body as defense-in-depth alongside the primary boundary: `EXECUTE` is revoked from `anon`/`authenticated` and granted only to `service_role`, so neither can call it at all regardless of the internal check.
- **The one deliberate use of the service-role client** (`src/server/db/supabase-service-role.ts`) — the sole exception to this codebase's "no service-role client anywhere" rule, exactly as anticipated when `SUPABASE_SERVICE_ROLE_KEY` was first reserved in `.env.example`. It is constructed only inside `runNotificationScheduler()`, which passes the same client on to Phase 6.3's delivery step — no code path other than `POST /api/cron/notifications` can reach it.
- **`POST /api/cron/notifications`** (`src/app/api/cron/notifications/route.ts`) is the Vercel Cron entry point, intended to run every minute. Gated by `CRON_SECRET` (`src/server/auth/cron.ts`'s `isAuthorizedCronRequest`, constant-time comparison): a missing header, a wrong secret, and an unconfigured `CRON_SECRET` are all identically a 401 — never distinguishable from the outside, so the route is never a publicly reachable mutation path even when unconfigured. Safe to invoke repeatedly and concurrently: the route holds no in-memory or process-local state at all; every safety guarantee lives in the one atomic database transaction.
- **No exactly-once delivery guarantee exists or is claimed** — there is no delivery yet to guarantee anything about. What Phase 6.2 does guarantee, precisely: a notification is never claimed twice, a stale claim is never stuck forever, and reconciliation never fabricates a second source of schedule truth. What happens after a successful claim (sending, retrying, recording an outcome) is entirely Phase 6.3's contract.
- **Not built:** Web Push delivery, the service worker, `notification_deliveries` (judged unnecessary for 6.2's own atomic-claim boundary — nothing here fans out to multiple subscriptions yet), any notification UI, preferences, quiet hours, and any change to `reschedule_task`/`apply_replan`/`confirm_ai_proposal`/`confirm_ai_proposal_by_id`/`change_task_status`/AI planning — all confirmed byte-for-byte unchanged by this phase.

#### Phase 6.3: Web Push delivery

Consumes exactly what Phase 6.2 atomically claims and sends it, fanning out to every active subscription of the notification's own user. Adds one production dependency (`web-push`, the established library — no hand-rolled VAPID signing or payload encryption anywhere in this codebase) and one migration, no new table. The service worker is explicitly out of scope (Phase 6.4): Phase 6.3 ends at "the provider accepted the request."

```
scheduled_notifications (claimed, Phase 6.2)
   │
   ▼
deliverClaimedNotifications()                    [src/server/services/notification-delivery.ts]
   │  for each claimed notification:
   │    1. read the task's title + the user's active (revoked_at is null) subscriptions
   │    2. build the deterministic payload (src/lib/notifications/task-reminder-payload.ts)
   │    3. sendWebPush() to EVERY active subscription, independently
   │    4. classify each result: success | permanently_invalid (404/410) | transient_failure
   │    5. revoke (never delete) each permanently_invalid subscription
   │    6. mark_notification_sent() iff at least one subscription succeeded
   ▼
web-push library → Browser Push Service → (Phase 6.4: service worker, not built)
```

- **Aggregate delivery policy (the one deliberate design decision this phase makes — chosen, not defaulted into):** at least one successful provider acceptance marks the notification `sent`, regardless of how many _other_ subscriptions failed — not every device has to succeed. Anything short of that (zero active subscriptions, all transient failures, all permanently invalid subscriptions, or a mix with no success) leaves the row `claimed` and does **nothing else** — Phase 6.2's own, already-hardened lease-recovery step decides its next state (reclaim it if attempts remain, `expired` if not) on a later cron tick. Phase 6.3 introduces no second attempt counter and no second retry mechanism; `mark_notification_sent` is the _only_ new terminal transition it performs.
- **Fan-out is fully independent per subscription.** A `for` loop over every active subscription; one subscription's failure (of either kind) never stops or skips another's attempt. A permanently invalid one is revoked (`revoke_push_subscription_by_id`, below) without interrupting the loop.
- **404/410 → permanently invalid → revoked** (`revoked_at = now()`, never a physical delete — the same posture Phase 6.1 already established for the user-facing revoke path). **Everything else — 429, any 5xx, any other 4xx, and any network-level failure (timeout, connection reset, DNS failure)** — is `transient_failure` and never revokes anything: classification is deliberately conservative (`src/server/notifications/web-push-provider.ts`), so an unrecognized error can never be silently treated as "this subscription is dead."
- **"2xx" means the provider accepted the request for relay — nothing more.** This codebase cannot know, and never claims, that the browser or OS actually displayed the notification, only that the delivery attempt itself succeeded up to the push service's own front door. This distinction is stated explicitly in code (`NotificationDeliveryOutcome`'s own doc comment) and is not just a documentation nicety: no field anywhere is named anything like `seen`/`displayed`.
- **At-least-once, not exactly-once, by design.** A notification is claimed (Phase 6.2, committed to the database) strictly before it is ever sent (this phase, a real network call). If the process crashes between a successful provider acceptance and `mark_notification_sent` actually running, the row is still `claimed`; its lease eventually expires and it becomes claimable — and sendable — again. This is an accepted, deliberately undocumented-away characteristic: Phase 6.3 does not attempt exactly-once delivery at any layer, and nothing in its design pretends otherwise.
- **Two new, narrowly scoped SECURITY DEFINER RPCs**, both `service_role`-only (same `auth.role() = 'service_role'` internal check as Phase 6.2's own RPC, same EXECUTE-grant boundary): `mark_notification_sent(p_notification_id)` (only affects a currently-`claimed` row; silent no-op otherwise) and `revoke_push_subscription_by_id(p_subscription_id)` (Phase 6.1's `revoke_push_subscription` is `auth.uid()`-scoped and unusable from a sessionless cron path; this is its system-facing sibling, addressed by id rather than ownership because there is no ownership claim to make on the system path). Neither accepts a user id of any kind.
- **A real grant-hygiene bug this phase's own Postgres verification caught, not code review**: a Supabase project's bootstrap grants `service_role` full INSERT/UPDATE/DELETE/SELECT on every table _by default_ (the same default `anon`/`authenticated` get, which every migration since 4.1b has carefully revoked — for `anon`/`authenticated` only). Phase 6.1/6.2 never revoked the equivalent for `service_role` on `push_subscriptions`/`scheduled_notifications`, leaving `service_role` able to write either table directly, bypassing the RPC boundary entirely, purely by an unexamined default. This migration closes it for all three tables Phase 6.3 touches (`tasks`, `push_subscriptions`, `scheduled_notifications`): `revoke all ... from service_role` followed by `grant select` only. Every existing RPC keeps working unchanged — they run as the function owner (`postgres`, a superuser), which bypasses grants entirely, so this could never have broken them; it only closes a door nothing was using.
- **Payload (`src/lib/notifications/task-reminder-payload.ts`, pure, no AI, no database, no `web-push` import):** `{ type: "task_reminder", notificationId, taskId, title: "Task reminder", body: "<task title, truncated to 90 chars> starts in 10 minutes", scheduledStart, url: "/today" }`. Deliberately excludes `user_id`, task notes (there is no field for them — `getTaskTitleForDelivery` selects only `title`, structurally, not by developer discipline), any auth/session/CRON_SECRET/service-role/VAPID material, and any AI-authored text (notification copy is fixed and server-generated; AI is never asked to write it). Stays well under 1KB regardless of title length, far under Web Push's own 4KB limit. `url` is the plain dashboard route, not a per-task deep link — the smallest useful destination for Phase 6.4's future service worker, which must treat this payload as untrusted, never authoritative for scheduling.
- **VAPID (`getWebPushConfig()`, `src/config/env.server.ts`):** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (unchanged from Phase 6.1, still client-safe) plus new server-only `VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`, read fresh on every call (not through the cached `getServerEnv()` bundle) so tests can stub fake values freely — no real production key is ever required to test this codebase. All-or-nothing, like `getAiConfig`: delivery throws a clear `InternalError` if any of the three is missing, before attempting anything. The private key never crosses into client code, is never logged (`private[-_]?key` added to the redaction regex), and is read in exactly one place, verified by a static boundary test.
- **Not built (Phase 6.4+):** `public/sw.js`, service worker registration, `push`/`notificationclick` handling, any notification UI, preferences, quiet hours, and — still — email/WhatsApp/SMS and any AI involvement in notification content or delivery decisions.

#### Phase 6.4: service worker (delivery/UI boundary)

Adds the browser-side layer that turns a Phase 6.3 Web Push delivery into a real OS/browser notification, and a click on it into in-app navigation. No dependency, no migration, no schema change — this phase is pure browser-side plumbing plus one narrow client integration.

```
Web Push provider (Phase 6.3) → Browser Push Service
   → public/sw.js `push` event (untrusted payload)
        → validate: supported type, required string fields, allowlisted url
        → self.registration.showNotification(title, {body, data})
   → user clicks the notification
        → public/sw.js `notificationclick` event
             → close notification; validate stored url against the same allowlist
             → focus an existing HitMeUp window at that url, else open one
```

- **`public/sw.js` is a plain, unbundled browser script, not TypeScript.** Next.js serves everything under `public/` verbatim at the site root (`/sw.js`), with no webpack/TS step — the same reason `next-env.d.ts` isn't linted the normal way. It is tested by loading its real source text into a Node `vm` sandbox that mocks only `self.addEventListener`/`registration.showNotification`/`clients.matchAll`/`clients.openWindow` (`tests/unit/service-worker.test.ts`) — this exercises the file's own validation logic exactly as shipped, not a duplicated TS reimplementation of it and not the Push/Notification APIs' own platform behavior.
- **The push payload is untrusted input, treated defensively at every step.** `event.data` may be absent; `.json()` may throw (caught); the parsed value may not be an object, may be an array, may have the wrong `type`, or may be missing/wrong-typed on any required field — every one of these results in "display nothing", never a thrown error. Only `type: "task_reminder"` (Phase 6.3's one kind) is ever handled; any other value, present or absent, is silently ignored.
- **`url` is validated against an explicit allowlist (`{"/today"}`), not a same-origin regex.** An allowlist of exact, known application destinations is deliberately stricter than trying to validate a URL's shape — `javascript:`, `data:`, `blob:`, external origins, and protocol-relative URLs are all designed to slip past shape-based checks, and all fail an exact-match allowlist by construction. The same allowlist gates both what gets stored in a shown notification's `data.url` and what `notificationclick` is willing to navigate to; `clients.openWindow(url)` is never called with a raw, unvalidated payload value.
- **`scheduledStart` is read from the payload but never used for anything.** The worker has no timing logic of any kind — the scheduler (Phase 6.2) and delivery service (Phase 6.3) already own every decision about when a notification fires; this file only reacts to a `push` event the browser already delivered.
- **Notification `data` is a small, deliberately narrowed object** (`{type, notificationId, taskId, url}`) — built fresh by the worker from the validated payload, not the raw payload forwarded wholesale, so nothing extra a future payload change might add (and nothing sensitive — there is nothing sensitive in this payload to begin with, per Phase 6.3's contract) can ride along into the displayed notification's `data`.
- **Lifecycle is intentionally minimal.** `install`/`activate` do nothing beyond the default (no precache, no cache strategy, no offline shell, no `clients.claim()`) — Phase 6.4 is the Web Push boundary, not a PWA/offline implementation; there is no concrete reason for this worker to aggressively take control of already-open pages, so it doesn't.
- **Client integration is the minimum needed for `getRegistration()` to find anything**: `registerServiceWorker()` (`src/lib/push/push-client.ts`) calls `navigator.serviceWorker.register("/sw.js")` and swallows any failure (the rest of the flow already treats "no registration" as the normal, non-crashing `service_worker_unavailable` outcome). Called once, from `usePushNotifications()`'s existing mount effect (`src/features/notifications/use-push-notifications.ts`), gated behind the same `isPushSupported()` check the rest of the hook already uses. Registering a worker requests no permission and creates no subscription — both still happen only from the "Enable notifications" button's own click handler, exactly as Phase 6.1 left them. Verified against a real dev server: the worker registers and becomes `active` at scope `/` on page load, with `Notification.permission` untouched.
- **No settings/permission/onboarding UI, no PWA install prompt, no device management** — all explicitly out of scope (Phase 6.5+, if ever built).
- **Not built:** any change to notification content, timing, or the aggregate delivery policy (all still exactly Phase 6.3's); a second cron/scheduling path; `notification preferences`; Cache API/offline support; a web app manifest. Web Push delivery to iOS Safari additionally requires the site to be added to the Home Screen (Apple's own platform restriction, not something this app's code can work around) — not claimed as supported here.

#### Phase 6.5: notification dashboard UX

Makes the Phase 6.1–6.4 machinery usable from the actual dashboard. No new backend, no schema change, no new dependency — this phase only wires the existing "Enable notifications" control (already present in the sidebar since Phase 6.1) into a properly explicit state model and a more robust enable flow, reusing every existing abstraction unchanged.

```
explicit click on "Enable notifications"
   → runEnableFlow()                          [src/features/notifications/push-notification-flow.ts]
        → subscribeToPush()                   [src/lib/push/push-client.ts — Phase 6.1/6.4, unchanged shape]
             → Notification.requestPermission() (ONLY here, ONLY now)
             → ensure service worker registered
             → reuse existing PushManager subscription, or create one
        → registerPushSubscriptionAction()    [Server Action → service → repository → RPC, Phase 6.1]
   → "enabled" only once the RPC itself has succeeded
```

- **The state model (`push-notification-flow.ts`) is a pure module with no React and no browser API of its own** — `checking`, `unsupported`, `not_configured`, `permission_denied`, `permission_default`, `permission_granted`, `subscribing`, `registering`, `enabled`, `revoking`, `error`. This mirrors the exact split `ai-planning/flow-state.ts` uses relative to `use-ai-plan-flow.ts`: every real decision (what a mount observation implies, whether a click may start something, what an enable/disable attempt's outcome means) lives in a plain, unit-tested function; the hook (`use-push-notifications.ts`) is a thin wrapper, verified by inspection like every other hook in this codebase — there is still no React Testing Library dependency.
- **`permission_default` and `permission_granted` are distinct states, and neither is `enabled`.** `Notification.permission === "granted"` only means the browser would allow notifications; it says nothing about whether this device holds a subscription or whether the server registered it, so a granted-but-unsubscribed device rests on `permission_granted` (the Enable control skips the prompt — the browser resolves an already-decided permission immediately) and only `permission_default` leads to a real prompt. Both render the same "Enable notifications" control. After a successful disable the control returns to whichever of the two matches the permission the browser reports (`stateAfterDisable`), since revoking a subscription does not revoke the permission. `permission_denied` is the state with no Enable control at all, so this UI can never re-request a denied permission — and the application cannot override a browser-denied permission, only explain the remedy.
- **`enabled` is set only after `registerPushSubscriptionAction` itself returns success** — never merely from `Notification.permission === "granted"` or from a successful browser-level `PushManager.subscribe()`. `runEnableFlow` has no code path that returns `{ kind: "enabled" }` any other way; there is no independent client-side "enabled" flag anywhere.
- **`subscribeToPush` gained one small, narrowly-scoped addition**: if no service-worker registration is found on the first check, it now retries `registerServiceWorker()` once and checks again, before giving up with `service_worker_unavailable`. This is placed strictly _after_ `Notification.requestPermission()` has already resolved — `Notification.requestPermission()` is still the very first thing the function does, with nothing awaited before it, because inserting an `await` earlier risks losing the click's "user activation" in strict browsers (Safari) and silently failing to prompt at all.
- **Duplicate clicks are closed by a plain state guard, not a lock or a debounce** — `canStartEnable`/`canStartDisable` are true only from `permission_default`/`permission_granted`/`error` and `enabled` respectively; a click during `subscribing`/`registering`/`revoking` is simply ignored. There is no legitimate race to guard against beyond this (unlike the AI-planning flow, there is no "a slower result lands after a faster one" hazard here), so no epoch mechanism was needed.
- **Errors are always user-safe, never raw.** `runEnableFlow`/`runDisableFlow` return only a fixed `PushClientError` message or the Server Action's own already-redacted `ActionErrorPayload.message` — never a caught error's raw `.message` or `String(error)`. A failed enable lands on `error` (retryable from the same button); a failed disable lands back on `enabled` (the subscription is still active server-side — showing anything else would falsely claim it's off).
- **UI (`notifications-control.tsx`) renders `subscribing` and `registering` identically** ("Enabling…") — the control communicates capability/state to the user, not this feature's internal step boundaries, per this phase's own objective. `error` renders the same "Enable notifications" button (so the user can simply retry) plus a one-line caption; `permission_denied` shows the blocked-in-browser explanation Phase 6.1 already had, reworded to name the actual remedy (browser settings).
- **Client-boundary review** (`push-boundaries.test.ts`, mirroring `lib/voice/boundaries.test.ts`'s style): no feature/lib push file imports the Supabase client or calls `.rpc(` directly; `registerPushSubscriptionAction`/`revokePushSubscriptionAction` are called only from `push-notification-flow.ts`, never from a component; no service-role/VAPID-private/CRON_SECRET string; no server-only environment variable is read (only `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, via the existing `getVapidPublicKey()`); no `userId`/`user_id` concept anywhere (ownership comes only from the authenticated server session, exactly as Phase 6.1 established); `Notification.requestPermission` is called from exactly one place in the whole codebase.
- **Ownership and multi-device, restated for this UI:** the browser only ever sends `{endpoint, p256dh, authKey}` through the Server Action; the owner of the resulting `push_subscriptions` row is always the authenticated server session (`auth.uid()` inside `register_push_subscription`), never anything the client supplies. Enabling this device never touches any other device's subscription — one user can hold many active rows, and this phase adds no device list or "revoke others" behavior. Permission is never requested automatically: not on mount, hydration, service-worker registration, login, or visiting `/today` — only from the control's own click handler.
- **Not built:** a settings page, a device list, notification history, custom reminder times/preferences — all explicitly out of scope; this phase only makes the existing single-purpose control fully correct and testable. No second disable/revoke workflow was added — the existing Phase 6.1 revoke path was preserved and given the same dependency-injected testability as enable.

#### Phase 6 live verification (what was and wasn't actually exercised)

Phase 6 (6.1–6.5) is **CODE-COMPLETE and verified at every layer that can run without a signed-in Supabase session — but NOT fully live-verified end to end.** The gap is exactly one thing: nobody has yet signed in with a real session, clicked "Enable notifications" with permission genuinely granted, and received a real OS notification from a real push service. Everything below was run for real; nothing was simulated and then reported as live.

**Run for real:**

- **Browser (real Chromium pane, running dev server, real generated VAPID public key):** `public/sw.js` registers, activates at scope `/`, and the key is a valid 65-byte P-256 key. `PushManager.subscribe()` with it was attempted and fails with `AbortError: permission denied`, because that browser's notification permission is pinned to `denied` and cannot be changed from here — so the _denied_ path is genuinely observed, and the _default_ and _granted_ paths are not.
- **Wire level (`src/server/notifications/web-push-wire.test.ts`):** the real `web-push` library (VAPID signing, `aes128gcm` encryption) against a local HTTPS server standing in for a push service. The `Authorization` JWT verifies against our public key with the configured subject and the push service's origin as `aud`; the body decrypts to exactly the seven-field payload contract (no user id, no notes, no credential-shaped text, under 1 KB); 404/410 classify as permanently invalid; 429, 5xx, an unexpected 400, and a refused connection classify as transient.
- **Cron route over real HTTP:** no header and a wrong secret → 401; GET → 405; the right secret passes the gate and then fails with a sanitized `Notification scheduling is not configured.` (the service-role key is not available locally) — no secret or internal detail in the response.
- **Bundle:** the private key and `CRON_SECRET` _values_ (not just their names) appear in zero client files; only the public key is inlined.
- **Real Postgres 17 (scratch cluster, Supabase-shaped roles and default privileges, all migrations applied from scratch):** the four Phase 6 SQL suites pass — reminder is exactly 10 minutes before start; completed/skipped/non-upcoming tasks never produce an actionable reminder and cancel a pending one; reschedule corrects `fire_at` and the old time cannot remain claimable; canceled/terminal rows are never claimable; repeated reconciliation is idempotent; an abandoned claim is recovered, and expires once attempts are exhausted; `mark_notification_sent` is idempotent and only affects a claimed row; `revoke_push_subscription_by_id` sets `revoked_at` and is silent on missing ids; cross-user isolation, no direct client writes, grants, `SECURITY DEFINER` + `search_path = ''`.
- **Two real connections (`supabase/tests/concurrent_cron_claims.sh`):** one invocation holds its locks while a second fires. Nothing is claimed twice and each notification ends `claimed` with `attempt_count = 1`.

**Defects this verification found and fixed (both additive migrations; no earlier migration edited):**

1. **`20261006090000_phase6_service_role_function_grants.sql` — `service_role` default privileges.** A Supabase project grants `service_role` full default privileges on every new table _and_ function. Phase 6.3 closed the table half for the three tables it touched; the other tables and every function were still open to it. Verified not exploitable (all 11 user-session RPCs refuse a `service_role` JWT with `42501` via their own `auth.uid()` check) but a real least-privilege gap that contradicted Phase 6.1's own documentation. Now `service_role` can EXECUTE exactly the three system RPCs and SELECT exactly `tasks`, `push_subscriptions`, `scheduled_notifications`. `supabase/tests/service_role_boundary.sql` asserts this for every `public` function and table (mutation-tested: re-granting a function, a table write, dropping an RPC's internal check, and removing a system RPC's grant are each caught). A table added by a later migration still arrives with Supabase's defaults and must revoke them in its own migration.
2. **`20261006100000_phase62_reconcile_concurrent_create.sql` — overlapping cron invocations.** Two ticks overlapping on a brand-new task both tried to insert its reminder; the loser aborted with a unique violation (one tick's 500; the next minute recovered). No double-claim and no corruption, but not "safe to repeat". One added clause, `on conflict (task_id, kind) where status in ('scheduled','claimed') do nothing`; the rest of the function is byte-for-byte Phase 6.2's. Reproduced before the fix and passing 3/3 after.

**Not live-tested (environment limits):** signed-in enable flow with permission _default_ or _granted_; a real push service (FCM/Mozilla/Apple) receiving a send; `push` → `showNotification` → `notificationclick` in a real browser (the handlers are exercised by `tests/unit/service-worker.test.ts` against the real source in a sandbox, not by a real `PushEvent`); the full task → reminder → delivery → OS notification chain end to end; the cron route against a real service-role key. The old `supabase/tests/rls_isolation.sql` predates the Phase 4.1b write lockdown (it inserts into `days` directly) and no longer runs — it was not part of Phase 6 and is superseded by the later per-phase suites.

#### Phase 7: end-of-day intelligence

The day's execution history, turned into one short, useful review: what actually happened, what was completed, skipped, or slipped, which patterns the facts support, what to carry forward, and the single most useful takeaway. It is a **read-and-report layer** — it reads the day, asks a model to interpret facts that were already computed, and stores one append-only report. It schedules nothing, changes no task, and is not a second scheduler.

```
authenticated user ──► generateEodReportAction()   [takes NO input: no date, day id, or user id]
   │                       │
   │                       ▼  generateEodReport()   [src/server/services/eod-report.ts]
   │      today's day (resolved server-side) → the day's own tasks (RLS + a second owner/day filter)
   │      → fingerprint of their persisted state → a report already written for THIS state? return it (no model call)
   │      → task_history + plan revisions (read-only)
   │                       ▼
   │      computeEodFacts()      DETERMINISTIC — outcomes, durations, times, counts, what moved   [src/domain/eod/facts.ts]
   │                       ▼
   │      EodInterpreter.interpret(facts)    the model sees titles + computed facts only   [src/server/ai/anthropic-eod.ts]
   │                       ▼
   │      Zod shape parse → validateEodInterpretation(facts, …)   UNTRUSTED output, deterministically checked
   │                       ▼
   │      create_eod_report()    SECURITY DEFINER RPC → eod_reports (append-only, owner-scoped)
   ▼
Today page: reads the saved report (no model call) + a live staleness comparison → EodPanel
```

- **Three layers, never mixed.** `EodFacts` is deterministic and comes from the database (a pure function of persisted rows and the clock: `computeEodFacts`). `EodInterpretation` is untrusted model output reduced to a closed shape — prose plus task refs — that may only _interpret_ the facts. `EodReport` is the validated pair as persisted. Nothing a model says can enter or change a fact: completion, durations, timestamps, priorities, titles, plan revisions and reschedule counts are all computed here. A test proves it: a model that claims "everything was completed" still gets a report whose stored facts say one task slipped.
- **Outcomes (exactly one per task, as of `asOf`):** `completed_on_time`, `completed_late` (completed after its scheduled end), `skipped` (a decision, not a failure), `slipped` (unresolved and its time has passed), `in_progress`, `not_yet_due`, `unscheduled` (replanning couldn't fit it). Progress uses the dashboard's own definition (`completed / (total − skipped)`). "What moved" comes from `task_history`: a row only counts as a move if its old and new windows actually differ (a replan row that merely flipped `unscheduled` moved nothing), and `netShiftMinutes` is measured from the _original_ recorded start.
- **The model's output is constrained twice.** A strict Zod schema (every object strict, so no hidden field can ride along; list items parsed one by one so a bad item doesn't sink the rest), then `validateEodInterpretation` against the facts the model was shown. **Prose may contain no digits, times, markup, links, or code** — every number a reader sees comes from the facts, so a digit in model prose is redundant or fabricated either way. **Tasks are named only by `[t3]`-style placeholders, rendered to the user's own title server-side** (`renderRefs`) — a model can never write a title, and an unknown alias is refused. **Carry-forward entries must name a task whose outcome is actually unresolved**, each at most once; a completed or skipped task can never be "carried forward". A bad summary or takeaway fails the whole response (`malformed_response`, not retried or repaired); a bad list entry is dropped and the rest kept. The panel's carry-forward list is built from the facts (every unresolved task), with the model's suggestion attached where it gave one — a model that forgets a task cannot make it disappear.
- **What the model is sent:** task titles (as untrusted data, angle brackets escaped so a hostile title can't close a delimiter) and the computed facts. **Never:** a task id, day id, user id, email, task notes, push subscription data, any credential, or any UUID — enforced by construction (the facts type has no such field) and by tests that scan the actual request. The system prompt is static; nothing user-supplied is ever interpolated into it.
- **Provider layer.** A separate port (`EodInterpreter`) and adapter (`anthropic-eod.ts`) beside the planning ones, reusing the planning adapter's failure classification and sanitising (`classify`, `sanitizedDiagnostic`) and the existing `AiError`: fixed client-safe messages, the provider's own error never attached, 20 s timeout, one call, no retry. `anthropic.ts` stays the only file that imports the SDK (it re-exports a client factory and two type aliases for the sibling adapter). A new optional `feature` argument on `AiError` only changes the wording of the "unavailable" message ("The end-of-day review isn't available right now."); every existing caller and message is untouched.
- **Persistence — why a new table (`eod_reports`, migration `20261006110000`).** No existing home fits: `ai_proposals` is a pre-confirmation artifact with a confirm path that applies changes (a review has none and must not be able to reach one), and `task_history`/`plan_revisions` are append-only _facts_ that must never hold AI prose. The facts are reproducible from the database, but the interpretation is not — regenerating it per page view would show a different narrative on every refresh, cost a model call per view, and silently rewrite what the user was told. So a report is a **snapshot**: facts _and_ validated interpretation as of generation. It is **append-only** (no UPDATE/DELETE policy or grant): a changed day appends a new report and the old one remains. No task id is stored anywhere (tasks are an alias plus their own title); notes are never part of a report.
- **Staleness is a live comparison, never a stored flag.** Each report stores `state_fingerprint` — a sha-256 of the day's _persisted_ task state (each task's status, window, `unscheduled` flag and completion instant; nothing time-dependent). The Today page recomputes it from the tasks it already read, so a day that merely got later is never "stale", every change that can alter a report (every task, history and revision change goes through an RPC that updates a task row) is caught, and nothing needs a background job to stay honest. A stale report is still shown, labelled "Your day has changed since this review", with an explicit "Update review" button — it never rewrites itself. If an older report was written against exactly the current state (a task moved back to where it was), that one is shown as current.
- **Idempotency and concurrency.** `UNIQUE (day_id, state_fingerprint)`: the first report for a given day-state stands. The service short-circuits before any model call when one exists, and `create_eod_report` returns the existing row on a replay; a genuine race is settled by the constraint (`on conflict … do nothing`, then return the winner's row — proved with two real connections, and the mutation of removing that clause fails the script). At most 20 reports per day (a ceiling on churn: each new row needs the day to have changed).
- **`create_eod_report` (SECURITY DEFINER, `search_path = ''`, `authenticated` only).** Enforces in SQL, not just in the caller: the day is the caller's (a foreign day id looks identical to a missing one); the day has **started** in its own frozen timezone (a future day is refused, `22023`); `facts.planningDate` and `facts.timezone` equal the day's own (a report cannot carry facts about a different day than the one it's filed under); the facts have 1–100 tasks and a totals object (an empty day is never stored); the interpretation has the closed key set with the right JSON types and length bounds; size caps. `service_role` is revoked on the table and the function explicitly (a Supabase project grants it full defaults on every new object — see "Phase 6 live verification"). Verified against a real Postgres 17 by `supabase/tests/eod_reports_isolation.sql` (53 assertions: ownership both ways, unauthenticated/anon/service_role, no direct writes, malformed input, future day, replay, append-only, cap, catalog facts) and mutation-tested (14 mutations — dropping the ownership filter, the day-started rule, the date binding, replay, the cap, the NULL-uid check, `search_path`, RLS, and re-granting `UPDATE`/`SELECT`/`EXECUTE` to the wrong roles — each caught).
- **Scope: today only, server-resolved.** The Server Action takes no input; the service reviews the caller's _current_ planning day (resolved from the profile clock, read-only — reviewing never creates a day). There is no date parameter to point it at a future or past day, and the Today snapshot never loads a review for a future date. A task belongs to the planning day it was created on: a task starting late today and ending after midnight is reviewed _today_ (still `in_progress`); a task that started yesterday and is still running is _yesterday's_ spillover and is not in today's review (tested, including a read that wrongly returned one — excluded by a second, independent filter).
- **UI (`src/features/dashboard/eod/`).** A single "Wrap up the day" card below the timeline and briefing, today only. It starts empty and is generated **only by an explicit click** — never on load or a timer, because each generation is a model call. It shows the takeaway first (the one thing to take away), then three counts (done / skipped / still open) with deterministic one-liners (late finishes, moves, plan changes) only when they happened, a short summary, patterns only if the facts support any, and every unresolved task with its planned window, a deterministic status label ("Past its time", "Not started", "Didn't fit the day") and the model's suggestion where it gave one. Read-only: nothing on it completes, skips, moves or schedules anything. No chart, no score, no motivational copy. Motion is a one-shot CSS fade (trivial → plain CSS; neutralised by the existing reduced-motion rule); no GSAP or Anime.js is used for it. Display mapping is a pure module (`eod-view.ts`), unit-tested like `proposal-view.ts`.
- **Failure behavior.** A provider failure, a timeout, or malformed/unvalidatable model output persists nothing and surfaces a fixed, client-safe message as a toast; the prior review (if any) stays on screen. Empty day: no model call, no storage, a neutral "Nothing to review yet" toast. A day over 100 tasks is refused before any model call.
- **Verification.** 1282 unit/integration tests (up from 1053): the facts (every outcome, the late/on-time boundary, history/move semantics, local-time and cross-midnight handling, purity, no ids/notes), the validator (fabricated refs, impossible carry-forward, numbers, markup, caps), the Zod parser (malformed/missing/wrong-type/hidden-field payloads), the prompt (no ids/notes/emails/credentials; escaping; static system prompt; strict tool schema), the provider adapter (including the real SDK with a stubbed `fetch`, timeouts, aborts, secret non-leakage), the service (empty, partial, cross-midnight, spillover exclusion, foreign-user exclusion, idempotency, every failure persisting nothing, staleness), the repositories, the display mapping, and structural boundary tests (the review UI/model layer can reach no repository, no service-role client, no notification code, no timer; the Server Action takes no input; the domain never reads the clock). 27 mutations of the important invariants were each caught on first attempt.
- **Not live-tested:** a real model call (there is no `ANTHROPIC_API_KEY` in this environment — the SDK path is exercised against a stubbed `fetch`, and a real model's _prose_ quality is therefore unobserved), and the signed-in end-to-end flow (the same magic-link constraint as every earlier phase; `tests/e2e/eod.spec.ts` holds the skipped stubs). The panel was checked visually in a real browser (dark/light, phone width) with representative data on a throwaway route, and its Server Action path was exercised live (signed out → a sanitized "Your session has expired" toast, button re-enabled).
- **Known limitations.** Qualitative prose can't be machine-verified: the validator guarantees the model names no non-existent task, carries forward nothing resolved, and states no number or time — not that its _judgment_ is wise. The no-digits rule is deliberately strict and will occasionally reject an otherwise fine response ("The AI's response couldn't be used. Please try again."). Only today can be reviewed, and past reports have no UI yet (`/history` is still the Phase 2 placeholder; the data is stored and owner-readable). Reviews are user-initiated only — there is no scheduled end-of-day generation or notification (that would be a new scheduler, which this phase deliberately does not add).

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
- **Tasks and task history have no direct write path.** `authenticated` and `anon` hold no INSERT/UPDATE/DELETE/TRUNCATE on `tasks` or `task_history` and the matching policies are dropped, so a user calling PostgREST with their own JWT cannot edit `status`, `source`, `day_id`, the schedule, `schedule_locked` or `unscheduled`, cannot create a planner task or a completed one, and cannot forge history. Only four RPCs write: `create_task_with_history`, `change_task_status`, `reschedule_task`, `apply_replan`.
- **Those RPCs are `SECURITY DEFINER`** (Phase 3's were `SECURITY INVOKER`). This is forced, not stylistic: an invoker function runs with the caller's privileges, so any grant that lets it write a column lets a direct UPDATE write it too — column-level grants cannot separate the two (verified in scratch Postgres). Because a definer function bypasses RLS, each one filters every statement on `(select auth.uid())`, pins `search_path = ''`, refuses a missing caller, and is executable by `authenticated` only. Task + history + revision commit atomically inside the function, and the terminal-state, source, lock and day-bound rules live there, in SQL.
- `create_task_with_history` only ever creates `source = 'user'` tasks; a future AI phase must add its own function to create planner tasks.
- **`days`, `plans` and `plan_revisions` are authenticated SELECT-only** (migration 4.1b is applied; `anon` has no access and RLS still scopes reads to the owner). Their writes go only through the SECURITY DEFINER RPCs: `ensure_day` creates a day with its plan and revision 1, and `reschedule_task` / `apply_replan` append later revisions. The application never writes these tables itself (a build-time test guards that).
- Still directly writable by an authenticated user, on their own rows only: `profiles` (the browser-reported timezone) and `briefings`. They carry no scheduling rule; a forged row there affects only that user's data.
- No mutation is optimistic: the UI updates local state only from what an action actually returned, never speculatively, so there is nothing to roll back on failure (`src/features/dashboard/dashboard-view.tsx`). One shared clock (`use-now.ts`, minute-aligned, resynced on tab focus, seeded from the server's `initialNow`) feeds the header, the Now marker and every task's derived state; it never writes to the database.

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
