import { test } from "@playwright/test";

/**
 * The Phase 3 spec's required persisted-flow test:
 *
 *   open Today -> create task -> change status -> refresh -> verify state persisted
 *
 * Deliberately left unimplemented rather than shipped half-verified. It needs an
 * authenticated browser session, and this app's only sign-in path is a real Supabase
 * magic-link email — there is no password or dev-bypass login, by design (see
 * PROJECT_ARCHITECTURE.md). Automating that requires one of:
 *
 *   1. A local Supabase stack (`supabase start`) with Inbucket/Mailpit, so the test can
 *      request a real magic link and read it back from the test inbox's HTTP API.
 *   2. A seeded session against a real test project, minted via the Admin API
 *      (`supabase.auth.admin.generateLink`) — note the resulting link's flow (PKCE `?code=`
 *      vs. implicit `#access_token=`) depends on the project's configured auth flow type,
 *      and must match what `src/app/auth/callback/route.ts` actually handles (`?code=`
 *      only, currently) or the redirect won't produce a session.
 *
 * This sandbox has neither the Supabase CLI/Docker nor a real project's credentials, so
 * this couldn't be built *and verified* honestly in this phase. Once a real Supabase
 * project is available, wire up one of the above, remove `test.skip`, and implement the
 * steps: navigate to /today, click "Add task", fill the dialog, assert the task appears;
 * click "Complete" on it, assert the toast and its "Completed" state; `page.reload()`;
 * assert the task is still there and still "Completed".
 */
test.skip("create task, change status, refresh, and it persists", () => {});
