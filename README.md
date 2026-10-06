# Hit-me-up — Personal AI Daily Dashboard

A personal command center for a student's day. Each morning you write a short brain-dump; the app turns it into a realistic time-blocked plan. During the day you complete, skip, delay or add tasks and the app replans what's left. At night it produces a concise report: done, missed, delayed, patterns, and one suggestion for tomorrow. Past plans and reports stay browsable.

The UI exists to answer one question: **what matters right now, and what should I do next?**

> Status: **Phase 4.1 complete** — Today is a live operating dashboard: a real clock, derived current/late state, complete/skip, duration-preserving manual rescheduling, tasks that cross midnight, planning for any day from today through today + 365, and an explicit, deterministic "Replan" that appends plan revisions. All six migrations are applied to the hosted project and present in `supabase/migrations/`. No AI yet.

## Prerequisites

- Node.js 24 LTS (`.nvmrc`; Node ≥ 22 is supported) and npm
- Git
- A Supabase project, and the [Supabase CLI](https://supabase.com/docs/guides/cli) to apply migrations (`brew install supabase/tap/supabase`, or see their docs) — Docker if you want to run Supabase locally instead of against a hosted project
- An Anthropic API key (AI phase onward)
- Later phases: Resend account, Twilio WhatsApp sender, Vercel account

## Database setup

Schema lives entirely in `supabase/migrations/` — nothing is set up by hand in the dashboard.

```bash
supabase link --project-ref <your-project-ref>   # or `supabase start` for a local stack
supabase db push                                  # applies supabase/migrations/*.sql
```

That creates every table, RLS policy and the five RPC functions the app relies on
(`create_task_with_history`, `change_task_status`, `reschedule_task` and `apply_replan` — the only write path to tasks and their history — and `ensure_day`, the only path that creates a planning day with its plan and first revision) — see
[PROJECT_ARCHITECTURE.md §16](PROJECT_ARCHITECTURE.md) for the schema, the RLS strategy, and
why atomic RPCs exist instead of plain inserts/updates. The database behaviour is checked by the
SQL suites in `supabase/tests/` (cross-user isolation, grants, atomic confirmation, the AI usage
limit, …) and the two-connection `concurrent_*.sh` scripts. `supabase/tests/run-all.sh` applies every
migration to a **disposable local Postgres** (it refuses anything non-local) behind a minimal
Supabase-shaped bootstrap and runs them all — that is also what the CI `database` job does:

```bash
PG_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bash supabase/tests/run-all.sh
```

This verifies the SQL on plain Postgres. It has **not** been executed against a real Supabase
project (see Known limitations).

## Known limitations

- **Magic links only work in the browser that requested them.** Open the emailed link in the
  same browser you signed in from. Opening it from a mail app that launches a different
  browser, or on another device, fails and returns you to `/login`. This is inherent to the
  PKCE flow the link currently uses.
- **The cross-browser fix is blocked by the Supabase free-tier default email provider.** The
  code and email template for it are written (`src/app/auth/confirm/`,
  `supabase/templates/magic_link.html`) but Supabase refuses custom templates without custom
  SMTP or a paid plan, so it is inactive. Configuring a custom SMTP provider or upgrading the
  plan is the future path.
- **Email limits:** the default provider allows 2 sign-in emails per hour and 1 per minute per
  address; exceeding it shows "A required upstream service failed."
- **The persisted-Today E2E is skipped** (`tests/e2e/persisted-today.spec.ts`): it needs a real
  authenticated email session, and there is deliberately no password login or auth bypass.
- **Cross-user RLS isolation is not executed against the live project.** Anonymous lockout and
  the signed-in user's own flow were verified live; user-A-versus-user-B isolation was not.
- **Replanning is report-only on real accounts until the AI phase.** It may move only `source = 'planner'` tasks, and nothing creates those yet; on a user-only day it reports overlaps and changes nothing. The planner itself is fully unit-tested with planner inputs.
- **The Phase 4 E2E specs are written but skipped** (`tests/e2e/live-today.spec.ts`), for the same real-auth reason as above.
- **Postgres and Node can disagree on a day's edges in rare cases** (an ambiguous midnight, or tz-rule differences for future dates); the stricter check wins. Details in PROJECT_ARCHITECTURE.md, _Planning days_.
- Sign-up is open — anyone with an email address can create an account.

## Architecture overview

Single Next.js (App Router) + TypeScript + Tailwind app.

- **PostgreSQL (Supabase)** is the source of truth; plans are append-only revisions.
- **Claude** is an intelligence layer: every response is parsed, Zod-validated and checked by deterministic scheduling rules before anything is saved.
- **Layers:** `app` (routes) → `features` (UI) → `domain` (pure logic); `server` holds db, AI, notifications, auth and services behind adapters.
- **Motion:** GSAP for orchestrated/spatial animation, Anime.js for micro-interactions, CSS for hover/focus; all respect `prefers-reduced-motion`.
- **Deploy:** Vercel + Supabase, Vercel Cron for scheduled jobs.

Full detail, directory layout, schema outline and open decisions: [PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md).

## Environment setup

Local secrets live in `.env.local` (gitignored). Copy `.env.example` to `.env.local`. It lists every variable name without values. Environment variables are validated with Zod at startup; only `NEXT_PUBLIC_*` non-secrets reach the browser. The variable contract is in section 11 of the architecture doc.

## Development commands

| Command             | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `npm run dev`       | Start the Next.js dev server                                       |
| `npm run build`     | Production build                                                   |
| `npm start`         | Serve the production build                                         |
| `npm run lint`      | ESLint                                                             |
| `npm run typecheck` | TypeScript, no emit                                                |
| `npm test`          | Vitest unit tests                                                  |
| `npm run test:e2e`  | Playwright smoke tests (builds and serves the app; uses dummy env) |
| `npm run format`    | Prettier                                                           |

First run of e2e needs `npx playwright install chromium`.

## Phase roadmap

0. Reconnaissance and architecture ✅
1. Production foundation: tooling, env contract, CI, error/logging infra, app shell ✅
2. Design system and the Today dashboard's visual shell (mock data) ✅
3. Database, domain model, auth and real persistence — mock data removed ✅
4. Live daily operating system: real Now state, derived late, reschedule, deterministic replanning with plan revisions ✅ — and, as Phase 4.1, cross-midnight tasks and future-day planning ✅
5. AI planning: briefing → Claude → validated, persisted plan (its tasks are the ones replanning may move). "Replan my day" will then offer manual deterministic replanning and an AI-assisted option (most useful with ~4+ unresolved tasks); the AI stays bound by the same scheduling invariants and server-side validation
6. End-of-day reports and history views
7. Reminders: Resend email, Twilio WhatsApp, cron processing
8. Hardening: full e2e coverage (incl. the persisted-Today flow deferred in Phase 3), accessibility audit, rate limiting, deploy runbook

Later, not yet scheduled: weekly/monthly analysis, growth tracking, smart nudges, calendar integration, voice briefing, focus mode, habit tracking.
