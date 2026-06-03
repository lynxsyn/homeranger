/**
 * Auth-gate E2E — the Supabase sign-in gate on the real built SPA.
 *
 * The suite runs with the frontend bypass ON (VITE_E2E_AUTH_BYPASS=1, see
 * playwright.config.ts) so every other spec reaches the app as the operator
 * without a real login. This spec proves BOTH sides of the gate deterministically
 * (no live Supabase needed — getSession reads local storage):
 *
 *   1. With the bypass active (default) the app mounts straight to the listings
 *      table (account avatar visible, no sign-in page).
 *   2. With the bypass turned off per-page (localStorage hr-e2e-bypass="off",
 *      set before load), the app shows the SignInPage gate instead — and the
 *      sign-in form (email + password) toggles to create-account.
 *
 * The real token round-trip (web signs in to live Supabase → API verifies the
 * JWT) is proven by the verifier unit tests, the per-user scoping integration
 * tests, and a manual live smoke test against the project — not baked into CI.
 */
import { expect, test } from "@playwright/test";

test("bypass active → the app mounts authenticated (no sign-in gate)", async ({
  page,
}) => {
  await page.goto("/listings");
  await expect(page.getByTestId("account-avatar")).toBeVisible();
  await expect(page.getByTestId("auth-page")).toHaveCount(0);
});

test("bypass off → the sign-in gate renders with an email + password form", async ({
  page,
}) => {
  // Turn the frontend bypass off for THIS page before any app code runs.
  await page.addInitScript(() =>
    window.localStorage.setItem("hr-e2e-bypass", "off"),
  );
  await page.goto("/listings");

  const auth = page.getByTestId("auth-page");
  await expect(auth).toBeVisible();
  await expect(page.getByTestId("auth-email")).toBeVisible();
  await expect(page.getByTestId("auth-password")).toBeVisible();
  await expect(page.getByTestId("auth-submit")).toHaveText(/Sign in/);
  // The app itself is gated away.
  await expect(page.getByTestId("account-avatar")).toHaveCount(0);

  // Toggle to create-account.
  await page.getByTestId("auth-toggle").click();
  await expect(page.getByTestId("auth-submit")).toHaveText(/Create account/);
});
