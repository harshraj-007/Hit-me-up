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
- **Manual replan is unchanged:** `apply_replan()`, planner tasks only. **AI proposals:** the pipeline above. **Not built:** proposal storage, human confirmation, and the dedicated AI confirmation/apply RPC. There is no UI or Server Action for this service yet.

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
