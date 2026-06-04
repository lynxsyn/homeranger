/**
 * Map-view E2E — the "homes on a map" modal on the listings page. The map icon
 * in the view-toggle group opens a modal that plots the (filtered) homes as
 * brand price pins next to a synced list; clicking a home selects it and offers
 * a link out to the agent's source page.
 *
 * Geocoding (postcode → lat/lng) is stubbed at the network boundary
 * (api.postcodes.io) with deterministic coordinates so the map is hermetic and
 * the pins are reproducible in CI. The real geocoder is unit-tested separately.
 */
import { expect, test } from "@playwright/test";

/** Deterministic coordinates for the seeded fixture postcodes. */
const COORDS: Record<string, [number, number]> = {
  "SE1 1AA": [51.504, -0.09],
  "SE1 0LR": [51.505, -0.098],
  "SE1 9PG": [51.506, -0.11],
  "SE1 7TY": [51.501, -0.108],
  "M3 4LZ": [53.476, -2.25],
};

test.beforeEach(async ({ page }) => {
  await page.route(/api\.postcodes\.io\/postcodes/, async (route) => {
    const body = route.request().postDataJSON() as { postcodes?: string[] };
    const result = (body.postcodes ?? []).map((q) => {
      const c = COORDS[(q ?? "").toUpperCase().trim()];
      return {
        query: q,
        result: c ? { postcode: q, latitude: c[0], longitude: c[1] } : null,
      };
    });
    await route.fulfill({ json: { status: 200, result } });
  });

  await page.goto("/listings");
  await expect(page.getByTestId("listings-table")).toBeVisible();
});

test("the map button opens a modal with a pin and a list row for a seeded home", async ({
  page,
}) => {
  await page.getByTestId("view-map").click();

  const modal = page.getByTestId("map-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("homes");

  // A known seeded home appears in the synced side list...
  await expect(
    modal.locator('[data-testid="maprow"]').filter({ hasText: "rivington street se1" }),
  ).toHaveCount(1);

  // ...and the map renders brand price pins (Leaflet divIcons).
  await expect(modal.locator(".map-pin").first()).toBeVisible();
});

test("selecting a home reveals a View source link to the agent's page", async ({
  page,
}) => {
  await page.getByTestId("view-map").click();
  const modal = page.getByTestId("map-modal");
  await expect(modal).toBeVisible();

  await modal
    .locator('[data-testid="maprow"]')
    .filter({ hasText: "rivington street se1" })
    .click();

  const link = modal.getByTestId("map-source-link");
  await expect(link).toHaveAttribute(
    "href",
    "https://listings.example.test/rivington-se1",
  );
  await expect(link).toHaveAttribute("target", "_blank");
});

test("Escape closes the map modal", async ({ page }) => {
  await page.getByTestId("view-map").click();
  await expect(page.getByTestId("map-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("map-modal")).toHaveCount(0);
});
