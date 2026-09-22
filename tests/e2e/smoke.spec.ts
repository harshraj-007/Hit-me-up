import { expect, test } from "@playwright/test";

test.describe("foundation smoke", () => {
  test("protected area redirects unauthenticated visitors to /login", async ({ page }) => {
    await page.goto("/today");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("root path is protected as well", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("unknown routes render the not-found page", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-page");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("health endpoint returns only coarse, non-sensitive status", async ({ request }) => {
    const res = await request.get("/api/health");
    // No real Supabase in e2e, so 503 ("down") is the expected result; 200 is also valid elsewhere.
    expect([200, 503]).toContain(res.status());
    expect(res.headers()["cache-control"]).toContain("no-store");

    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["checks", "status", "timestamp"]);
    expect(Object.keys(body.checks)).toEqual(["database"]);
    expect(text).not.toContain("e2e-anon-key-not-a-secret");
    expect(text).not.toContain("54399");
  });

  test("security headers are set", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["x-powered-by"]).toBeUndefined();
  });
});
