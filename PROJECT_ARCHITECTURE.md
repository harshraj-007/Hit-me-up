# Project Architecture — Personal AI Daily Dashboard

Status: **Phase 0 (agreed baseline, pending approval of open decisions at the bottom).**
Nothing is scaffolded yet; this document is the contract for phases 1+.

## 1. Product in one line

A personal command center that turns a morning brain-dump into a realistic time-blocked plan, replans as the day changes, and closes with a concise report. The UI answers one question: *"What matters right now, and what should I do next?"*

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

| Item | Finding |
|---|---|
| Project type | **Empty project** (git repo + README only) |
| Commits | 1 (`first commit`) |
| package.json / lockfile | none |
| Source, config (TS, Tailwind, Next, ESLint) | none |
| Env files, DB config, deployment config | none |
| Tests | none |
| Toolchain | Node v26.0.0, npm 12.0.2, git 2.54; pnpm not installed |

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
    env.ts                    # Zod-validated env; server vs public split
supabase/
  migrations/                 # SQL, source-controlled
  seed.sql
tests/
  unit/ (colocated *.test.ts also allowed)  e2e/
```

Rules: `domain/` imports nothing from `server/`, `app/` or React. `server/` files use `import "server-only"`. Route handlers and server actions are thin: authenticate → validate input → call a service → shape response.

## 5. Dependencies

Versions verified against the npm registry on 2026-09-22 (to be re-checked at install time).

| Purpose | Package | Latest | Note |
|---|---|---|---|
| Framework | `next`, `react`, `react-dom` | 16.3.x / 19.3.x | App Router |
| Language | `typescript` | 7.0.2 | **See decision D1** |
| Styling | `tailwindcss` (+ `@tailwindcss/postcss`) | 4.3.x | CSS-first config (no `tailwind.config.js`) |
| Validation | `zod` | 4.x | |
| Dates | `date-fns` (+ `@date-fns/tz`) | 4.x | Timezone-aware days |
| Icons | `lucide-react` | 1.x | |
| DB/Auth | `@supabase/supabase-js`, `@supabase/ssr` | 2.x / 0.12 | |
| AI | `@anthropic-ai/sdk` | 0.127 | Server-only |
| Email (later) | `resend` | 6.x | Phase-gated |
| WhatsApp (later) | `twilio` | 6.x | Phase-gated |
| Motion | `gsap`, `animejs` | 3.15 / 4.x | Anime.js v4 API differs from v3 (named imports) |
| Unit tests | `vitest` | 5.x | |
| E2E | `@playwright/test` | 1.63 | |
| Lint/format | `eslint` (+ `eslint-config-next`), `prettier` | 10.x | Check Next plugin compat with ESLint 10 |
| Misc | `server-only`, `clsx` | | |

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

| Variable | Scope | Phase |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | 1–2 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or publishable key) | public | 1–2 |
| `NEXT_PUBLIC_APP_URL` | public | 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | server only, jobs/admin | when needed |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | server only | AI phase |
| `RESEND_API_KEY`, `EMAIL_FROM` | server only | reminders |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | server only | reminders |
| `CRON_SECRET` | server only | scheduling |

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

| Phase | Scope |
|---|---|
| 0 | Reconnaissance, architecture, README (this) |
| 1 | Scaffold: Next.js, TS, Tailwind, ESLint/Prettier, Vitest, Playwright config, env contract, CI, design tokens, app shell |
| 2 | Supabase: migrations, RLS, generated types, repositories, auth (sign-in, session, route protection) |
| 3 | Domain core: task model, scheduling engine, validation, unit tests (no AI) |
| 4 | Briefing capture + AI plan generation pipeline (prompts, Zod, business-rule validation, retry, logging) |
| 5 | Today dashboard: "what now / next", timeline, task actions (complete/skip/late/add/reprioritize) |
| 6 | Replanning with plan revisions and history preservation |
| 7 | Motion system (GSAP + Anime.js) applied to dashboard |
| 8 | End-of-day reports + history views |
| 9 | Reminders: Resend email, Twilio WhatsApp, cron processing |
| 10 | Hardening: e2e suite, a11y audit, rate limiting, security headers, deploy runbook |

Future (explicitly not planned yet): weekly/monthly analysis, growth tracking, smart nudges, calendar integration, voice briefing, focus mode, habit tracking.

## 15. Open decisions (need approval)

- **D1 TypeScript version:** pin to TS 5.x/6.x until tooling is verified on 7, or adopt 7.0.
- **D2 Node version:** pin to a Vercel-supported LTS (recommend 24 LTS) via `.nvmrc` + `engines`, rather than local Node 26.
- **D3 Auth method and access control:** magic link vs Google OAuth vs both; single-user allow-list vs open sign-up.
- **D4 Package manager:** npm (installed) vs pnpm (recommended, needs install).
- **D5 Scheduling:** Vercel Cron on current plan vs external trigger (e.g. Supabase pg_cron/Edge) for minute-level reminders.
- **D6 Rate limiting:** Postgres-backed counters (no new service) vs Upstash Redis.
- **D7 Claude model:** default model for planning and whether a cheaper model handles reports.
