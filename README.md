# Hit-me-up — Personal AI Daily Dashboard

A personal command center for a student's day. Each morning you write a short brain-dump; the app turns it into a realistic time-blocked plan. During the day you complete, skip, delay or add tasks and the app replans what's left. At night it produces a concise report: done, missed, delayed, patterns, and one suggestion for tomorrow. Past plans and reports stay browsable.

The UI exists to answer one question: **what matters right now, and what should I do next?**

> Status: **Phase 1 complete** — production foundation (tooling, env, health, errors, logging, DB connection, app shell). No product features yet.

## Prerequisites

- Node.js 24 LTS (`.nvmrc`; Node ≥ 22 is supported) and npm
- Git
- A Supabase project (or the Supabase CLI + Docker for a local stack)
- An Anthropic API key (AI phase onward)
- Later phases: Resend account, Twilio WhatsApp sender, Vercel account

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
1. Scaffold, tooling, env contract, CI, app shell ✅
2. Supabase schema, RLS, repositories, authentication
3. Domain core: task model and scheduling engine (no AI)
4. Briefing capture and AI plan generation pipeline
5. Today dashboard and task actions
6. Replanning with plan revisions
7. Motion system (GSAP + Anime.js)
8. End-of-day reports and history
9. Reminders (email, WhatsApp) and cron processing
10. Hardening: e2e, accessibility, rate limiting, deploy runbook

Later, not yet scheduled: weekly/monthly analysis, growth tracking, smart nudges, calendar integration, voice briefing, focus mode, habit tracking.
