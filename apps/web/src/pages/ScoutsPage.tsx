/**
 * ScoutsPage — the HomeRanger Scouts screen. A faithful port of the
 * claude.ai/design handoff (scout-design/project/app/campaigns.jsx), renamed
 * campaign → scout throughout, wired to real tRPC (`trpc.scouts.*`) instead of
 * localStorage.
 *
 * Each scout is a standing brief the email agent works from: where to look,
 * what kind of home, budget, condition/land/sale rules, and a free-text taste
 * description that shapes the outreach emails. The editor shows a LIVE preview
 * of that email via the client-side `draftScoutEmail` mirror (the deterministic
 * twin of backend-core's `draftScoutEmail`). Resuming a scout is instant;
 * pausing opens a relationship-safe confirm first.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@homeranger/backend-core";
import {
  SCOUT_PROPERTY_TYPES,
  SCOUT_CONDITIONS,
  SCOUT_LAND_OPTIONS,
  SCOUT_SALE_METHODS,
} from "@homeranger/shared";
import type {
  ScoutStatus,
  ScoutPropertyType,
  ScoutCondition,
  ScoutLandOption,
  ScoutSaleMethod,
} from "@homeranger/shared";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import { Button, Chip } from "../components/ui";
import { relativeTime } from "../lib/format";

type Scout = inferRouterOutputs<AppRouter>["scouts"]["list"][number];

/** What ScoutsPage needs to push the listings view into a scout's filter. */
export interface ScoutFilter {
  name: string;
  outcodes: string[];
  status: ScoutStatus;
}

/* ---- Editor form ---------------------------------------------------------- */
/** The editor's working copy. Prices/beds are pounds/strings here (DOM inputs);
 *  they convert to `maxPricePence` (pence) + `minBedrooms` (int|null) on save. */
interface ScoutForm {
  id: string | null;
  name: string;
  location: string;
  types: ScoutPropertyType[];
  condition: ScoutCondition[];
  land: ScoutLandOption[];
  saleMethods: ScoutSaleMethod[];
  minBeds: string; // free text → number | null
  maxPrice: string; // whole POUNDS → maxPricePence on save
  keywords: string;
  status: ScoutStatus;
}

const BLANK: ScoutForm = {
  id: null,
  name: "",
  location: "",
  types: [],
  condition: [],
  land: [],
  saleMethods: ["Private treaty"],
  minBeds: "",
  maxPrice: "",
  keywords: "",
  status: "active",
};

/**
 * Seed the editor form from an existing scout row (pence → pounds). The DB
 * stores the option fields as `text[]`, so the row exposes them as `string[]`;
 * they are validated against the closed SCOUT_* sets on every create/update, so
 * narrowing them back to the enum unions here is safe.
 */
function formFromScout(scout: Scout): ScoutForm {
  return {
    id: scout.id,
    name: scout.name,
    location: scout.location,
    types: [...scout.types] as ScoutPropertyType[],
    condition: [...scout.condition] as ScoutCondition[],
    land: [...scout.land] as ScoutLandOption[],
    saleMethods: [...scout.saleMethods] as ScoutSaleMethod[],
    minBeds: scout.minBedrooms == null ? "" : String(scout.minBedrooms),
    maxPrice:
      scout.maxPricePence == null ? "" : String(Math.round(scout.maxPricePence / 100)),
    keywords: scout.keywords,
    status: scout.status,
  };
}

/* ---- Email draft (client mirror of backend-core's draftScoutEmail) -------- */
const GBP_FULL = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

/** "£625k" / "£900" for the card budget chip; null when no max. */
function gbpShort(pounds: number | null): string | null {
  if (pounds == null) {
    return null;
  }
  return pounds >= 1000 ? `£${Math.round(pounds / 1000)}k` : `£${pounds}`;
}

/**
 * Deterministic client-side twin of backend-core's `draftScoutEmail` — keeps
 * the editor preview in lock-step with the email the agent actually sends.
 * Takes the editor form (pounds), so the preview updates as you type.
 */
function draftScoutEmail(form: ScoutForm): string {
  // Mirror backend-core's draftScoutEmail exactly: trim the location, and only
  // count a positive integer min-beds (a "0" or blank shows no beds clause).
  const loc = (form.location || "your area").split(/[,—–-]/)[0].trim();
  const locationPhrase = form.location.trim() || loc;
  const typeList =
    form.types.length > 0 ? form.types.map((t) => t.toLowerCase()) : ["home"];
  const types =
    typeList.length > 1
      ? typeList.slice(0, -1).join(", ") + " or " + typeList[typeList.length - 1]
      : typeList[0];
  const bedsNum = Number(form.minBeds);
  const beds =
    form.minBeds !== "" && Number.isInteger(bedsNum) && bedsNum > 0
      ? `${bedsNum}+ bedroom `
      : "";
  const priceNum = form.maxPrice === "" ? null : Number(form.maxPrice);
  const price =
    priceNum != null && Number.isFinite(priceNum) && priceNum > 0
      ? `, up to ${GBP_FULL.format(priceNum)}`
      : "";
  const taste = form.keywords.trim();

  let conditionLine = "";
  if (
    form.condition.includes("Restoration project") ||
    form.condition.includes("Full renovation")
  ) {
    conditionLine =
      "I'm glad to take on a renovation or full restoration — condition isn't a barrier. ";
  } else if (form.condition.includes("Some updating")) {
    conditionLine = "Some updating is fine. ";
  }

  let landLine = "";
  if (form.land.length > 0) {
    const parts: string[] = [];
    if (form.land.includes("Land with a building to convert")) {
      parts.push("land with a building to convert, such as a farmhouse or barn");
    }
    if (form.land.includes("Buildable land or planning potential")) {
      parts.push("a plot with planning permission or genuine potential");
    }
    if (parts.length > 0) {
      landLine = `I'd also consider ${parts.join(", or ")}. `;
    }
  }

  const auctionLine = form.saleMethods.includes("Auction")
    ? "I follow the auction lots too, so do flag anything coming under the hammer. "
    : "";

  const body = (conditionLine + landLine + auctionLine).trim();

  return (
    `Hello,\n\n` +
    `I'm a private buyer searching in ${locationPhrase} for a ${beds}${types}${price}.\n\n` +
    (taste ? `In short: ${taste}\n\n` : "") +
    (body ? `${body}\n\n` : "") +
    `If anything's coming up that fits — including pre-market or off-portal — I'd be glad to hear from you before it reaches the portals. Happy to move quickly for the right place.\n\n` +
    `Many thanks`
  );
}

/* ---- Global kill-switch (pause ALL sending) ------------------------------ */
/**
 * The system-wide outreach kill-switch (M6 `WarmupState.killSwitch`, the 5th
 * compliance gate). When ON, no approved send leaves the building regardless of
 * per-scout state — a single, prominent panic stop. Reads
 * `outreach.killSwitch.get` and flips it via `outreach.killSwitch.toggle`.
 */
function KillSwitch() {
  const utils = trpc.useUtils();
  const { data } = trpc.outreach.killSwitch.get.useQuery();
  const toggle = trpc.outreach.killSwitch.toggle.useMutation({
    onSuccess: () => {
      void utils.outreach.killSwitch.get.invalidate();
    },
  });
  // Treat undefined (loading) as "not paused" so the control reads safe-by-default.
  const enabled = data?.enabled ?? false;
  return (
    <div
      className={`killswitch${enabled ? " is-on" : ""}`}
      data-testid="kill-switch"
      data-enabled={enabled}
    >
      <span className="killswitch__face">
        <span className="killswitch__icon">
          <Icon name="power" size={16} />
        </span>
        <span className="killswitch__copy">
          <span className="killswitch__title">Outreach</span>
          <span className="killswitch__state" data-testid="kill-switch-state">
            {enabled ? "Sending paused" : "Sending live"}
          </span>
        </span>
      </span>
      <button
        type="button"
        className={`killswitch__toggle${enabled ? " is-on" : ""}`}
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? "Resume all outreach" : "Pause all outreach"}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate({ enabled: !enabled })}
      >
        <span className="killswitch__knob" />
      </button>
    </div>
  );
}

/* ---- Per-scout stats strip ----------------------------------------------- */
/**
 * The live counters for one scout — homes found in its patch and how many
 * agents in the patch have already been contacted. Lazy per-card query
 * (`scouts.stats`) so the list view stays one cheap `scouts.list` call until a
 * card is on screen.
 */
function ScoutStats({ scoutId }: { scoutId: string }) {
  const { data, isLoading } = trpc.scouts.stats.useQuery({ id: scoutId });
  return (
    <span className="sc-stats" data-testid="scout-stats">
      <span className="sc-stat">
        <Icon name="home" size={13} />
        <b>{isLoading || !data ? "–" : data.homesFound}</b> homes
      </span>
      <span className="sc-stat">
        <Icon name="send" size={13} />
        <b>{isLoading || !data ? "–" : data.agentsContacted}</b>/
        {isLoading || !data ? "–" : data.agentsInPatch} agents
      </span>
    </span>
  );
}

/* ---- Status pill (click to pause / resume) ------------------------------- */
interface StatusPillProps {
  status: ScoutStatus;
  onToggle: () => void;
}

function StatusPill({ status, onToggle }: StatusPillProps) {
  const active = status === "active";
  return (
    <button
      type="button"
      data-testid="scout-status-pill"
      className={`statuspill ${active ? "is-active" : "is-paused"}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={active ? "Pause this scout" : "Resume this scout"}
    >
      <Icon name={active ? "pause" : "play"} size={13} />
      {active ? "Active" : "Paused"}
    </button>
  );
}

/* ---- Scout card ----------------------------------------------------------- */
interface ScoutCardProps {
  scout: Scout;
  onOpen: (scout: Scout) => void;
  onToggle: (scout: Scout) => void;
  onViewHomes: (scout: Scout) => void;
  onLaunch: (scout: Scout) => void;
}

function ScoutCard({ scout, onOpen, onToggle, onViewHomes, onLaunch }: ScoutCardProps) {
  const maxPricePounds =
    scout.maxPricePence == null ? null : Math.round(scout.maxPricePence / 100);
  // We can link through to the scout's patch whenever it resolved any outcodes;
  // the actual home count lives on the filtered Listings view (no per-scout
  // counter ships in this PR).
  const canViewHomes = scout.outcodes.length > 0;
  return (
    <div
      className={`hs-card hs-card--interactive scout-card${scout.status === "paused" ? " is-paused" : ""}`}
      data-testid="scout-card"
      data-scout-name={scout.name}
      onClick={() => onOpen(scout)}
    >
      <div className="sc-main">
        <div className="sc-head">
          <h3 className="sc-name">{scout.name}</h3>
          <div className="sc-controls">
            <button
              type="button"
              className="sc-launch"
              data-testid="scout-launch"
              disabled={!canViewHomes}
              title={
                canViewHomes
                  ? "Launch — find agents and prepare outreach"
                  : "Add a place with target outcodes first"
              }
              onClick={(e) => {
                e.stopPropagation();
                onLaunch(scout);
              }}
            >
              <Icon name="rocket" size={14} /> Launch
            </button>
            <StatusPill status={scout.status} onToggle={() => onToggle(scout)} />
            <span className="sc-edit" aria-hidden="true">
              <Icon name="sliders-horizontal" size={16} />
            </span>
          </div>
        </div>
        <div className="sc-chips">
          {scout.location && <Chip icon="map-pin">{scout.location}</Chip>}
          {scout.types.map((t) => (
            <Chip key={t} icon="home">
              {t}
            </Chip>
          ))}
          {scout.minBedrooms != null && (
            <Chip icon="bed-double">{scout.minBedrooms}+ beds</Chip>
          )}
          {maxPricePounds != null && <Chip>{gbpShort(maxPricePounds)} max</Chip>}
          {scout.condition
            .filter((x) => x === "Full renovation" || x === "Restoration project")
            .map((x) => (
              <Chip key={x} accent>
                {x}
              </Chip>
            ))}
          {scout.saleMethods.includes("Auction") && (
            <span className="listing-tag" data-testid="scout-auction-tag">
              Auction
            </span>
          )}
        </div>
        {scout.keywords && <p className="sc-keywords">{scout.keywords}</p>}
      </div>
      <div className="sc-foot">
        {canViewHomes ? (
          <button
            type="button"
            className="sc-link"
            data-testid="scout-homes-link"
            onClick={(e) => {
              e.stopPropagation();
              onViewHomes(scout);
            }}
          >
            <Icon name="home" size={14} /> View homes found
            <Icon name="arrow-right" size={13} />
          </button>
        ) : (
          <span className="sc-muted">
            <Icon name="home" size={14} /> No patch yet
          </span>
        )}
        {canViewHomes && <ScoutStats scoutId={scout.id} />}
        <span className="sc-spacer" />
        <span className="sc-seen">Last activity {relativeTime(scout.updatedAt)}</span>
      </div>
    </div>
  );
}

/* ---- Chip-select group ---------------------------------------------------- */
interface ChipSelectProps {
  label: string;
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
  hint?: ReactNode;
}

function ChipSelect({ label, options, selected, onToggle, hint }: ChipSelectProps) {
  return (
    <div className="hs-field">
      <span>{label}</span>
      <div className="chipselect">
        {options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              className={`chipselect__opt${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() => onToggle(opt)}
            >
              {on && <Icon name="check" size={14} />}
              {opt}
            </button>
          );
        })}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/* ---- Location type-ahead -------------------------------------------------- */
/**
 * The scout "Where" field, backed by the bundled UK location index via
 * `trpc.locations.suggest`. As the operator types a county / town / region /
 * postcode, suggestions appear (debounced); picking one stores its canonical
 * label as the location — the server then resolves that to the scout's outcodes.
 * The hint on each row shows the catchment size, so it's clear how wide a net a
 * choice casts before saving. Keyboard: ↑/↓ to move, Enter to pick, Esc to close
 * (Esc is swallowed so it doesn't also close the editor modal).
 */
function LocationTypeahead({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState(value);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(t);
  }, [value]);

  const q = debounced.trim();
  const { data: suggestions } = trpc.locations.suggest.useQuery(
    { q },
    { enabled: q.length >= 2, staleTime: 60_000 },
  );
  const items = suggestions ?? [];
  const showList = open && items.length > 0;

  // Keep the highlighted row in range when an async result set shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function choose(label: string) {
    onChange(label);
    setOpen(false);
  }

  return (
    <div className="hs-typeahead" ref={boxRef}>
      <div className="hs-search">
        <Icon name="search" size={16} />
        <input
          className="hs-input"
          data-testid="scout-location"
          placeholder="Hampstead, NW3 · or Snowdonia, Gwynedd"
          value={value}
          role="combobox"
          aria-expanded={showList}
          aria-autocomplete="list"
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={
            showList ? `${listId}-opt-${active}` : undefined
          }
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            // ArrowDown reopens a closed list for the current text (standard
            // combobox affordance) before the open-state handlers run.
            if (!showList) {
              if (e.key === "ArrowDown" && items.length > 0) {
                e.preventDefault();
                setOpen(true);
                setActive(0);
              }
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const s = items[active];
              if (s) choose(s.label);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </div>
      {showList && (
        <ul
          className="hs-typeahead__list"
          data-testid="scout-location-suggestions"
          id={listId}
          role="listbox"
        >
          {items.map((s, i) => (
            <li
              key={`${s.kind}:${s.label}`}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
            >
              <button
                type="button"
                tabIndex={-1}
                className={`hs-typeahead__opt${i === active ? " is-active" : ""}`}
                data-testid="scout-location-suggestion"
                data-kind={s.kind}
                data-outcodes={s.outcodes.length}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s.label);
                }}
              >
                <span className="hs-typeahead__label">{s.label}</span>
                <span className="hs-typeahead__hint">{s.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---- Editor modal --------------------------------------------------------- */
interface ScoutEditorProps {
  initial: ScoutForm;
  isNew: boolean;
  saving: boolean;
  deleting: boolean;
  onSave: (form: ScoutForm) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function ScoutEditor({
  initial,
  isNew,
  saving,
  deleting,
  onSave,
  onDelete,
  onClose,
}: ScoutEditorProps) {
  const [form, setForm] = useState<ScoutForm>(initial);
  const [showPreview, setShowPreview] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    nameRef.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  function set<K extends keyof ScoutForm>(key: K, value: ScoutForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  // The chip-select options come straight from the closed SCOUT_* enum arrays,
  // so a toggled `value` is always a valid member of the field's union — cast
  // through `string[]` to keep the toggle logic field-agnostic.
  function toggleArr(field: "types" | "condition" | "land" | "saleMethods", value: string) {
    setForm((f) => {
      const cur = f[field] as string[];
      const next = cur.includes(value)
        ? cur.filter((x) => x !== value)
        : [...cur, value];
      return { ...f, [field]: next } as ScoutForm;
    });
  }

  const valid = form.name.trim().length > 0;
  const busy = saving || deleting;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={isNew ? "New scout" : "Edit scout"}
        data-testid="scout-editor"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <div>
            <span className="eyebrow">{isNew ? "New scout" : "Edit scout"}</span>
            <h2 className="modal__title">
              {isNew ? "What are you looking for?" : form.name || "Edit scout"}
            </h2>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="modal__body">
          <label className="hs-field">
            <span>Scout name</span>
            <input
              ref={nameRef}
              className="hs-input"
              data-testid="scout-name"
              placeholder="e.g. Snowdonia — detached with a view"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>

          <label className="hs-field">
            <span>Where</span>
            <LocationTypeahead
              value={form.location}
              onChange={(v) => set("location", v)}
            />
            <p className="field-hint">
              Start typing a county, town, region or postcode — pick one and the
              agent writes to its local estate agents.
            </p>
          </label>

          <ChipSelect
            label="Property type"
            options={SCOUT_PROPERTY_TYPES}
            selected={form.types}
            onToggle={(v) => toggleArr("types", v)}
          />

          <ChipSelect
            label="Condition"
            options={SCOUT_CONDITIONS}
            selected={form.condition}
            onToggle={(v) => toggleArr("condition", v)}
            hint="How much of a project you’ll take on — agents describe condition in their emails."
          />

          <ChipSelect
            label="Land & development"
            options={SCOUT_LAND_OPTIONS}
            selected={form.land}
            onToggle={(v) => toggleArr("land", v)}
            hint="Leave off to skip bare land. Pick what makes a plot worth sending — a building to convert, or room to build with planning."
          />

          <ChipSelect
            label="Sale method"
            options={SCOUT_SALE_METHODS}
            selected={form.saleMethods}
            onToggle={(v) => toggleArr("saleMethods", v)}
            hint="Auction lots suit dilapidated and restoration buys — include them to hear about lots early."
          />

          <div className="field-row">
            <label className="hs-field">
              <span>Min bedrooms</span>
              <input
                className="hs-input"
                data-testid="scout-min-beds"
                type="number"
                min="0"
                placeholder="Any"
                value={form.minBeds}
                onChange={(e) => set("minBeds", e.target.value)}
              />
            </label>
            <label className="hs-field">
              <span>Max price (£)</span>
              <input
                className="hs-input"
                data-testid="scout-max-price"
                type="number"
                min="0"
                step="5000"
                placeholder="No limit"
                value={form.maxPrice}
                onChange={(e) => set("maxPrice", e.target.value)}
              />
            </label>
          </div>

          <label className="hs-field">
            <span>What you&rsquo;re looking for</span>
            <textarea
              className="hs-textarea"
              data-testid="scout-keywords"
              rows={4}
              placeholder="Describe your taste in plain words — features, mood, must-haves and deal-breakers."
              value={form.keywords}
              onChange={(e) => set("keywords", e.target.value)}
            />
            <p className="field-hint">
              <Icon name="sparkles" size={13} /> This shapes the emails sent to agents
              and how their replies are scored against your taste.
            </p>
          </label>

          <div className="preview">
            <button
              type="button"
              className="preview__toggle"
              data-testid="scout-preview-toggle"
              onClick={() => setShowPreview((s) => !s)}
            >
              <Icon name={showPreview ? "chevron-down" : "mail"} size={15} />
              {showPreview
                ? "Hide outreach preview"
                : "Preview the email agents will receive"}
            </button>
            {showPreview && (
              <pre className="preview__body" data-testid="scout-email-preview">
                {draftScoutEmail(form)}
              </pre>
            )}
          </div>
        </div>

        <div className="modal__foot">
          {!isNew && form.id ? (
            <button
              type="button"
              className="hs-btn hs-btn--ghost danger-text"
              data-testid="scout-delete"
              disabled={busy}
              onClick={() => onDelete(form.id as string)}
            >
              <Icon name="trash-2" size={16} /> {deleting ? "Deleting…" : "Delete"}
            </button>
          ) : (
            <span />
          )}
          <div className="modal__foot-right">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="scout-save"
              disabled={!valid || busy}
              onClick={() => onSave(form)}
            >
              {saving ? "Saving…" : isNew ? "Create scout" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Pause confirmation --------------------------------------------------- */
interface ConfirmPauseProps {
  scout: Scout;
  pausing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmPause({ scout, pausing, onCancel, onConfirm }: ConfirmPauseProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onCancel]);

  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div
        className="modal modal--confirm"
        role="dialog"
        aria-modal="true"
        aria-label="Pause scout"
        data-testid="scout-pause-confirm"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="confirm-body">
          <div className="confirm-mark">
            <Icon name="pause" size={22} />
          </div>
          <h2 className="confirm-title">Pause this scout?</h2>
          <p className="confirm-text">
            HomeRanger will stop reaching out to new agents and stop pulling in new
            listings for <b>{scout.name}</b>. No message is sent to anyone — your
            existing conversations stay open and warm, and you can resume any time.
          </p>
        </div>
        <div className="modal__foot modal__foot--end">
          <Button variant="secondary" onClick={onCancel} disabled={pausing}>
            Keep active
          </Button>
          <Button
            variant="primary"
            icon="pause"
            data-testid="scout-pause-confirm-btn"
            disabled={pausing}
            onClick={onConfirm}
          >
            {pausing ? "Pausing…" : "Pause scout"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---- Launch loop modal ---------------------------------------------------- */
/**
 * The Scout Launch loop, operator-driven and send-safe end to end:
 *
 *   1. LAUNCH   — `scouts.launch` enqueues agent discovery across the scout's
 *                 outcodes (M7). Returns the outcodes it's working.
 *   2. REVIEW   — `scouts.reviewDrafts` returns the woven scout email + every
 *                 agent in the patch, each pre-checked by ComplianceGuard
 *                 (`eligible` + a `reason` code when blocked).
 *   3. APPROVE  — the operator ticks the eligible agents and confirms;
 *                 `scouts.approveSends` enqueues the guarded M6 send for each.
 *
 * No email is ever sent autonomously: a send only fires after the operator
 * approves AND the worker's ComplianceGuard passes (corporate-only, not opted
 * out, not suppressed, breaker closed, kill-switch off, warm-up cap free).
 */
interface LaunchModalProps {
  scout: Scout;
  onClose: () => void;
}

type ReviewAgent = inferRouterOutputs<AppRouter>["scouts"]["reviewDrafts"]["agents"][number];

function LaunchModal({ scout, onClose }: LaunchModalProps) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sentCount, setSentCount] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Kick discovery, then pull the drafts + pre-checked agents. reviewDrafts only
  // runs once launch has resolved so the patch reflects the just-found agents.
  const launch = trpc.scouts.launch.useMutation();
  const review = trpc.scouts.reviewDrafts.useQuery(
    { id: scout.id },
    {
      // Runs on open (independent of the launch mutation's resolution) so the
      // woven draft shows immediately; discovery is async (worker-consumed), so
      // poll until the just-found agents land in the patch, then stop.
      refetchInterval: (query) =>
        query.state.data && query.state.data.agents.length === 0 ? 1500 : false,
    },
  );
  const approve = trpc.scouts.approveSends.useMutation({
    onSuccess: (res) => setSentCount(res.enqueued),
  });

  // Auto-launch on open so the operator's single click ("Launch") drives the
  // whole loop; the modal then walks discovery → review → approve.
  const launchMutate = launch.mutate;
  const launchedRef = useRef(false);
  useEffect(() => {
    if (!launchedRef.current) {
      launchedRef.current = true;
      launchMutate({ id: scout.id });
    }
  }, [launchMutate, scout.id]);

  // Default-select every eligible agent the moment the review lands, so the
  // common case (approve everyone the guard cleared) is one click.
  const agents = review.data?.agents ?? [];
  const seededRef = useRef(false);
  useEffect(() => {
    // Pre-select every eligible agent the moment agents FIRST appear (discovery
    // may land them after the initial empty review), so the common case (approve
    // everyone the guard cleared) is a single click.
    if (!seededRef.current && agents.length > 0) {
      seededRef.current = true;
      setChecked(new Set(agents.filter((a) => a.eligible).map((a) => a.id)));
    }
  }, [agents]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const eligibleCount = agents.filter((a) => a.eligible).length;
  const checkedCount = checked.size;
  // "Finding agents…" while the launch enqueue is in flight, the first review is
  // loading, or discovery hasn't yet landed any agents in the patch.
  const loading =
    launch.isPending ||
    review.isLoading ||
    (review.data != null && agents.length === 0);
  const launchFailed = launch.isError;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal modal--launch"
        role="dialog"
        aria-modal="true"
        aria-label={`Launch ${scout.name}`}
        data-testid="launch-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <div>
            <span className="eyebrow">
              <Icon name="rocket" size={13} /> Launch scout
            </span>
            <h2 className="modal__title">{scout.name}</h2>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        {sentCount != null ? (
          <div className="launch-sent" data-testid="launch-sent">
            <div className="confirm-mark launch-sent__mark">
              <Icon name="send" size={22} />
            </div>
            <h3 className="confirm-title">
              {sentCount === 0
                ? "No sends queued"
                : `${sentCount} ${sentCount === 1 ? "agent" : "agents"} queued`}
            </h3>
            <p className="confirm-text">
              {sentCount === 0
                ? "Nothing was approved, so no outreach was queued."
                : "Each send still passes the live ComplianceGuard before it leaves — corporate-only, not opted out, kill-switch off, within the warm-up cap."}
            </p>
          </div>
        ) : (
          <div className="modal__body">
            {loading && (
              <div className="launch-busy" data-testid="launch-busy">
                <Icon name="loader" size={18} className="spin" />
                Finding estate agents across {scout.outcodes.join(", ") || "this patch"}…
              </div>
            )}

            {launchFailed && (
              <div className="launch-error" role="alert">
                {launch.error?.message ?? "Couldn’t launch this scout."}
              </div>
            )}

            {review.data && (
              <>
                <div className="launch-section">
                  <span className="launch-label">The email each agent receives</span>
                  <pre className="preview__body" data-testid="launch-draft">
                    {review.data.draft}
                  </pre>
                </div>

                <div className="launch-section">
                  <span className="launch-label">
                    Agents in patch
                    <span className="launch-count">
                      {eligibleCount} eligible · {agents.length} found
                    </span>
                  </span>
                  {agents.length === 0 ? (
                    <p className="launch-empty">
                      No estate agents found in this patch yet.
                    </p>
                  ) : (
                    <ul className="launch-agents">
                      {agents.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          checked={checked.has(agent.id)}
                          onToggle={() => toggle(agent.id)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {sentCount != null ? (
          <div className="modal__foot modal__foot--end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="modal__foot modal__foot--end">
            <Button variant="secondary" onClick={onClose} disabled={approve.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="send"
              data-testid="launch-approve"
              disabled={
                !review.data || checkedCount === 0 || approve.isPending
              }
              onClick={() =>
                approve.mutate({ id: scout.id, agentIds: [...checked] })
              }
            >
              {approve.isPending
                ? "Queuing…"
                : `Approve & send ${checkedCount}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Single agent row in the launch checklist ---------------------------- */
interface AgentRowProps {
  agent: ReviewAgent;
  checked: boolean;
  onToggle: () => void;
}

function AgentRow({ agent, checked, onToggle }: AgentRowProps) {
  return (
    <li
      className={`launch-agent${agent.eligible ? "" : " is-blocked"}`}
      data-testid="launch-agent"
      data-eligible={agent.eligible}
    >
      <label className="launch-agent__label">
        <input
          type="checkbox"
          className="launch-agent__check"
          checked={checked}
          disabled={!agent.eligible}
          onChange={onToggle}
        />
        <span className="launch-agent__body">
          <span className="launch-agent__name">
            {agent.agencyName || agent.email}
          </span>
          <span className="launch-agent__email">{agent.email}</span>
        </span>
        {agent.eligible ? (
          <span className="launch-agent__ok">
            <Icon name="check" size={13} /> Eligible
          </span>
        ) : (
          <span className="launch-agent__reason" title={agent.reason ?? undefined}>
            {agent.reason ?? "Blocked"}
          </span>
        )}
      </label>
    </li>
  );
}

/* ---- Screen --------------------------------------------------------------- */
type EditingState =
  | { kind: "new" }
  | { kind: "edit"; scout: Scout }
  | null;

export interface ScoutsPageProps {
  onViewHomes: (filter: ScoutFilter) => void;
}

export function ScoutsPage({ onViewHomes }: ScoutsPageProps) {
  const utils = trpc.useUtils();
  const { data, isLoading, isError, refetch } = trpc.scouts.list.useQuery();

  const [editing, setEditing] = useState<EditingState>(null);
  const [pausing, setPausing] = useState<Scout | null>(null);
  const [launching, setLaunching] = useState<Scout | null>(null);

  const invalidate = () => {
    void utils.scouts.list.invalidate();
  };

  const create = trpc.scouts.create.useMutation({
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
  });
  const update = trpc.scouts.update.useMutation({
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
  });
  const remove = trpc.scouts.delete.useMutation({
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
  });
  const setStatus = trpc.scouts.setStatus.useMutation({
    onSuccess: () => {
      invalidate();
      setPausing(null);
    },
  });

  const scouts = data ?? [];
  const activeCount = useMemo(
    () => scouts.filter((s) => s.status === "active").length,
    [scouts],
  );

  function viewHomes(scout: Scout) {
    onViewHomes({ name: scout.name, outcodes: scout.outcodes, status: scout.status });
  }

  // Resuming is instant; pausing asks first so there's no doubt about contact.
  function requestToggle(scout: Scout) {
    if (scout.status === "active") {
      setPausing(scout);
    } else {
      setStatus.mutate({ id: scout.id, status: "active" });
    }
  }

  function save(form: ScoutForm) {
    // 0 (or blank/invalid) means "no minimum" — store null so the card, the
    // email draft, and the wire all agree (no "0+ beds" chip).
    const minBedsNum = Number(form.minBeds);
    const minBedrooms =
      form.minBeds === "" || !Number.isInteger(minBedsNum) || minBedsNum <= 0
        ? null
        : minBedsNum;
    const maxPrice = form.maxPrice === "" ? null : Number(form.maxPrice);
    const maxPricePence =
      maxPrice == null || !Number.isFinite(maxPrice)
        ? null
        : Math.round(maxPrice * 100);
    const base = {
      name: form.name.trim(),
      location: form.location.trim(),
      types: form.types,
      condition: form.condition,
      land: form.land,
      saleMethods: form.saleMethods,
      minBedrooms,
      maxPricePence,
      keywords: form.keywords,
      status: form.status,
    };
    if (form.id) {
      update.mutate({ id: form.id, ...base });
    } else {
      create.mutate(base);
    }
  }

  const saving = create.isPending || update.isPending;

  return (
    <main>
      <div className="page-head page-head--row">
        <div>
          <h1 className="t-h1">Scouts</h1>
          <p>
            Each scout works a patch for you — where to look, what kind of home, and
            the taste that shapes every message it sends to local agents.
          </p>
        </div>
        <div className="page-head__actions">
          <KillSwitch />
          <Button
            variant="primary"
            icon="search"
            data-testid="new-scout"
            onClick={() => setEditing({ kind: "new" })}
          >
            New scout
          </Button>
        </div>
      </div>

      {isError ? (
        <div className="empty" role="alert">
          <p>Couldn&rsquo;t load your scouts.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="empty" aria-busy="true">
          <p>Loading scouts…</p>
        </div>
      ) : (
        <>
          <div className="controls">
            <span className="count" data-testid="scouts-count">
              <b>{scouts.length}</b> scouts · <b className="green">{activeCount}</b>{" "}
              active
            </span>
          </div>

          {scouts.length === 0 ? (
            <div className="empty" data-testid="scouts-empty">
              <div className="empty-mark">
                <Icon name="search" size={26} />
              </div>
              <p>No scouts yet. Create one to start scouting.</p>
              <Button
                variant="secondary"
                icon="search"
                onClick={() => setEditing({ kind: "new" })}
              >
                New scout
              </Button>
            </div>
          ) : (
            <div className="scout-list">
              {scouts.map((scout) => (
                <ScoutCard
                  key={scout.id}
                  scout={scout}
                  onOpen={(s) => setEditing({ kind: "edit", scout: s })}
                  onToggle={requestToggle}
                  onViewHomes={viewHomes}
                  onLaunch={setLaunching}
                />
              ))}
            </div>
          )}
        </>
      )}

      {editing && (
        <ScoutEditor
          initial={editing.kind === "edit" ? formFromScout(editing.scout) : BLANK}
          isNew={editing.kind === "new"}
          saving={saving}
          deleting={remove.isPending}
          onSave={save}
          onDelete={(id) => remove.mutate({ id })}
          onClose={() => setEditing(null)}
        />
      )}

      {pausing && (
        <ConfirmPause
          scout={pausing}
          pausing={setStatus.isPending}
          onCancel={() => setPausing(null)}
          onConfirm={() => setStatus.mutate({ id: pausing.id, status: "paused" })}
        />
      )}

      {launching && (
        <LaunchModal scout={launching} onClose={() => setLaunching(null)} />
      )}
    </main>
  );
}
