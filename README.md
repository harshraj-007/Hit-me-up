# Hit-me-up — Personal AI Daily Dashboard

A personal command center for a student's day. Each morning you write a short brain-dump; the app turns it into a realistic time-blocked plan. During the day you complete, skip, delay or add tasks and the app replans what's left. At night it produces a concise report: done, missed, delayed, patterns, and one suggestion for tomorrow. Past plans and reports stay browsable.

The UI exists to answer one question: **what matters right now, and what should I do next?**

> Status: **Phase 3 complete** — real persistence. Today reads and writes Postgres through Supabase Auth: sign in with a magic link, add a task, mark it complete/skipped/late, and it's there on refresh. No AI planning yet.

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

That creates every table, RLS policy and the two RPC functions the app relies on
(`create_task_with_history`, `change_task_status`) — see
[PROJECT_ARCHITECTURE.md §16](PROJECT_ARCHITECTURE.md) for the schema, the RLS strategy, and
why two atomic RPCs exist instead of plain inserts/updates. `supabase/tests/rls_isolation.sql`
is a from-scratch check that one user can't read or write another's rows. **It has not been
executed against the live project** (see Known limitations). To run it, start a local stack
(`supabase start`, needs Docker) and follow the `psql` command in the comment at the top of the
file — it is a plain SQL script, not a pgTAP test, so `supabase test db` will not run it.

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
4. AI planning: briefing → Claude → validated, persisted plan
5. Replanning with plan revisions, built on the Phase 3 plan/revision tables
6. End-of-day reports and history views
7. Reminders: Resend email, Twilio WhatsApp, cron processing
8. Hardening: full e2e coverage (incl. the persisted-Today flow deferred in Phase 3), accessibility audit, rate limiting, deploy runbook

Later, not yet scheduled: weekly/monthly analysis, growth tracking, smart nudges, calendar integration, voice briefing, focus mode, habit tracking.
