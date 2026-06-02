/**
 * PreferencesPage (M5) — edits the single SearchProfile that the AI match score
 * ranks listings against. Loads the profile via `preferences.get`, saves a
 * partial update via `preferences.update` (which fires the analysis backfill so
 * every listing is re-scored), then invalidates the query so the form reflects
 * the persisted state.
 *
 * Free text drives the embedding + LLM re-score; the structured fields
 * (min beds / max price / outcodes / tenure) are the vector pre-filter + extra
 * signal. Max price is entered in POUNDS and converted to integer pence.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useState } from "react";
import { TENURES, type Tenure } from "@homescout/shared";
import { trpc } from "../lib/trpc";

const TENURE_LABELS: Record<Tenure, string> = {
  freehold: "Freehold",
  leasehold: "Leasehold",
  share_of_freehold: "Share of freehold",
  commonhold: "Commonhold",
  unknown: "No preference",
};

export function PreferencesPage() {
  const utils = trpc.useUtils();
  const { data, isLoading, isError } = trpc.preferences.get.useQuery();
  const update = trpc.preferences.update.useMutation({
    onSuccess: () => {
      void utils.preferences.get.invalidate();
    },
  });

  const [freeText, setFreeText] = useState("");
  const [minBeds, setMinBeds] = useState("");
  const [maxPricePounds, setMaxPricePounds] = useState("");
  const [outcodes, setOutcodes] = useState("");
  const [tenure, setTenure] = useState<Tenure | "">("");

  // Seed the form once the profile loads (and after a save invalidates it).
  useEffect(() => {
    if (!data) {
      return;
    }
    setFreeText(data.freeTextPreferences);
    setMinBeds(data.minBedrooms === null ? "" : String(data.minBedrooms));
    setMaxPricePounds(
      data.maxPricePence === null ? "" : String(Math.round(data.maxPricePence / 100)),
    );
    setOutcodes(data.outcodes.join(", "));
    setTenure(data.requiredTenure ?? "");
  }, [data]);

  function submitPreferences() {
    const parsedBeds = Number(minBeds);
    const parsedPounds = Number(maxPricePounds);
    const parsedOutcodes = outcodes
      .split(",")
      .map((o) => o.trim().toUpperCase())
      .filter((o) => o.length > 0);

    update.mutate({
      freeTextPreferences: freeText,
      minBedrooms:
        minBeds.trim() && Number.isInteger(parsedBeds) && parsedBeds >= 0
          ? parsedBeds
          : null,
      maxPricePence:
        maxPricePounds.trim() && Number.isFinite(parsedPounds) && parsedPounds >= 0
          ? Math.round(parsedPounds * 100)
          : null,
      outcodes: parsedOutcodes,
      requiredTenure: tenure === "" ? null : tenure,
    });
  }

  if (isError) {
    return (
      <main className="preferences-page">
        <h1>Preferences</h1>
        <div role="alert">Couldn&apos;t load your preferences.</div>
      </main>
    );
  }

  return (
    <main className="preferences-page">
      <h1>Preferences</h1>
      <p>Describe the home you want — listings are scored against this.</p>

      <form
        className="preferences-form"
        aria-label="Search preferences"
        aria-busy={isLoading ? "true" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submitPreferences();
        }}
      >
        <label>
          <span>What are you looking for?</span>
          <textarea
            data-testid="preferences-freetext"
            rows={4}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="e.g. A bright, modern 2-bed flat with a garden near the river"
          />
        </label>
        <label>
          <span>Min bedrooms</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            data-testid="preferences-min-beds"
            value={minBeds}
            onChange={(e) => setMinBeds(e.target.value)}
          />
        </label>
        <label>
          <span>Max price (£)</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            data-testid="preferences-max-price"
            value={maxPricePounds}
            onChange={(e) => setMaxPricePounds(e.target.value)}
          />
        </label>
        <label>
          <span>Outcodes (comma-separated)</span>
          <input
            type="text"
            data-testid="preferences-outcodes"
            value={outcodes}
            onChange={(e) => setOutcodes(e.target.value)}
            placeholder="e.g. SE1, SE16"
          />
        </label>
        <label>
          <span>Tenure</span>
          <select
            data-testid="preferences-tenure"
            value={tenure}
            onChange={(e) => setTenure(e.target.value as Tenure | "")}
          >
            <option value="">No preference</option>
            {TENURES.filter((t) => t !== "unknown").map((t) => (
              <option key={t} value={t}>
                {TENURE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          data-testid="preferences-save"
          disabled={update.isPending}
        >
          {update.isPending ? "Saving…" : "Save preferences"}
        </button>

        {update.isSuccess ? (
          <p role="status" data-testid="preferences-saved">
            Preferences saved — listings are being re-scored.
          </p>
        ) : null}
        {update.isError ? (
          <p role="alert" data-testid="preferences-error">
            Couldn&apos;t save your preferences.
          </p>
        ) : null}
      </form>
    </main>
  );
}
