/**
 * SettingsPage — the "Your details" account screen (a faithful port of the
 * claude.ai/design handoff, project/app/settings.jsx SettingsScreen). Captures
 * the operator's own identity — first/last name, phone, and how urgently they're
 * looking — and persists it to the single SearchProfile via `preferences.update`.
 *
 * This isn't decorative: the saved details sign + pace EVERY outreach email.
 * Name + phone become the sign-off; the urgency choice injects (or relaxes) the
 * closing line. The "How this reads to agents" panel previews both live, using
 * the SAME shared helpers (signatureBlock / urgencyLine) the backend draft uses,
 * with the RESEND_FROM sender name as the sign-off fallback when no name is set.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useRef, useState } from "react";
import {
  OUTREACH_URGENCY_LEVELS,
  DEFAULT_OUTREACH_URGENCY,
  buyerFullName,
  signatureBlock,
  urgencyLine,
  type OutreachUrgency,
} from "@homeranger/shared";
import { trpc } from "../lib/trpc";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui";
import { OutreachStatus } from "../components/OutreachStatus";

interface Identity {
  firstName: string;
  lastName: string;
  phone: string;
  urgency: OutreachUrgency;
}

const BLANK: Identity = {
  firstName: "",
  lastName: "",
  phone: "",
  urgency: DEFAULT_OUTREACH_URGENCY,
};

function identityOf(profile: {
  firstName: string;
  lastName: string;
  phone: string;
  urgency: string;
}): Identity {
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    // Narrow the stored string to the closed urgency set; an unexpected value
    // (e.g. a future level) degrades to the default rather than breaking the UI.
    urgency:
      (OUTREACH_URGENCY_LEVELS.find((u) => u.id === profile.urgency)?.id ??
        DEFAULT_OUTREACH_URGENCY) as OutreachUrgency,
  };
}

export function SettingsPage() {
  const utils = trpc.useUtils();
  const { data: profile } = trpc.preferences.get.useQuery();
  // The RESEND_FROM display name — the sign-off fallback when no buyer name set.
  const { data: sender } = trpc.outreach.senderName.useQuery();
  // The outreach control (kill-switch + warm-up) is operator-only — the backend
  // (operatorProcedure) FORBIDs a non-operator, so we only render it for the
  // operator. Non-operators just see their own details.
  const { data: me } = trpc.auth.me.useQuery();
  const isOperator = me?.isOperator ?? false;

  const [draft, setDraft] = useState<Identity>(BLANK);
  const [saved, setSaved] = useState(false);
  const seededRef = useRef(false);
  const firstRef = useRef<HTMLInputElement>(null);

  // Focus the first field once the form mounts (after the profile loads — the
  // form is gated on it below, so [] would fire before the input exists).
  useEffect(() => {
    firstRef.current?.focus();
  }, [profile]);

  // Seed the form ONCE from the loaded profile (a later refetch after save must
  // not clobber an in-progress edit).
  useEffect(() => {
    if (profile && !seededRef.current) {
      seededRef.current = true;
      setDraft(identityOf(profile));
    }
  }, [profile]);

  const update = trpc.preferences.update.useMutation({
    onSuccess: () => {
      setSaved(true);
      void utils.preferences.get.invalidate();
    },
  });

  function set<K extends keyof Identity>(key: K, value: Identity[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  const baseline = profile ? identityOf(profile) : BLANK;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  function save() {
    update.mutate({
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      phone: draft.phone.trim(),
      urgency: draft.urgency,
    });
  }

  // Live preview of how the sign-off + urgency read to agents — same resolution
  // as the backend: buyer's name wins, RESEND_FROM name is the fallback.
  const previewName = buyerFullName(draft) || sender?.name || null;
  const previewSignature = signatureBlock(previewName, draft.phone);
  const previewUrgency = urgencyLine(draft.urgency);

  // Gate the editable form on the profile load so the one-time seed ALWAYS
  // completes before the fields are interactive — otherwise a fast edit can be
  // clobbered when the async profile arrives mid-typing (the seededRef seeds
  // late). Fields auto-wait for this in tests, and users see no blank flash.
  if (!profile) {
    return (
      <main className="settings" data-testid="settings-page" aria-busy="true">
        <div className="page-head">
          <span className="settings-eyebrow">Account</span>
          <h1 className="t-h1">Your details</h1>
        </div>
        <p className="settings-loading" data-testid="settings-loading">
          Loading your details…
        </p>
      </main>
    );
  }

  return (
    <main className="settings" data-testid="settings-page">
      <div className="page-head">
        <span className="settings-eyebrow">Account</span>
        <h1 className="t-h1">Your details</h1>
        <p>
          Used to sign the messages HomeRanger sends to estate agents on your
          behalf, and to shape how those emails read. Nothing here is shared
          until an agent is contacted.
        </p>
      </div>

      {isOperator && (
        <section className="settings-section" data-testid="settings-outreach">
          <span className="settings-eyebrow">Outreach</span>
          <OutreachStatus />
        </section>
      )}

      <div className="settings-grid">
        <div className="hs-card settings-card">
          <div className="field-row">
            <label className="hs-field">
              <span>First name</span>
              <input
                ref={firstRef}
                className="hs-input"
                data-testid="settings-first-name"
                placeholder="Jane"
                value={draft.firstName}
                onChange={(e) => set("firstName", e.target.value)}
              />
            </label>
            <label className="hs-field">
              <span>Last name</span>
              <input
                className="hs-input"
                data-testid="settings-last-name"
                placeholder="Whitfield"
                value={draft.lastName}
                onChange={(e) => set("lastName", e.target.value)}
              />
            </label>
          </div>

          <label className="hs-field">
            <span>Phone number</span>
            <input
              className="hs-input"
              type="tel"
              inputMode="tel"
              data-testid="settings-phone"
              placeholder="07700 900123"
              value={draft.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
            <p className="field-hint">
              <Icon name="phone" size={13} /> Added to your sign-off so agents
              can reach you directly. Leave blank to keep it email-only.
            </p>
          </label>

          <div className="hs-field">
            <span>How urgently you&rsquo;re looking</span>
            <div className="urgency-list" data-testid="settings-urgency">
              {OUTREACH_URGENCY_LEVELS.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  data-testid={`urgency-${u.id}`}
                  className={`urgency-opt${draft.urgency === u.id ? " is-on" : ""}`}
                  aria-pressed={draft.urgency === u.id}
                  onClick={() => set("urgency", u.id)}
                >
                  <span className="uo-radio" aria-hidden="true" />
                  <span className="uo-text">
                    <b>{u.label}</b>
                    <small>{u.note}</small>
                  </span>
                </button>
              ))}
            </div>
            <p className="field-hint">
              <Icon name="sparkles" size={13} /> Sets the tone of your outreach —
              from a relaxed note to a clear signal that you&rsquo;re ready to act.
            </p>
          </div>
        </div>

        <div className="sig-card" aria-live="polite">
          <div className="sig-card__head">
            <Icon name="mail" size={14} /> How this reads to agents
          </div>
          <div className="sig-block">
            <p className="sig-label">Your sign-off</p>
            <pre className="sig-body" data-testid="settings-signature">
              {previewSignature}
            </pre>
          </div>
          <div className="sig-block">
            <p className="sig-label">Urgency line in your emails</p>
            {previewUrgency ? (
              <pre className="sig-body" data-testid="settings-urgency-line">
                {previewUrgency}
              </pre>
            ) : (
              <p className="sig-body sig-body--muted">
                No urgency line added — your emails stay relaxed and open-ended.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="settings-foot">
        <Button
          variant="primary"
          icon="check"
          data-testid="settings-save"
          disabled={!dirty || update.isPending}
          onClick={save}
        >
          {update.isPending ? "Saving…" : "Save details"}
        </Button>
        {saved && !dirty && (
          <span className="saved-note" data-testid="settings-saved">
            <Icon name="shield-check" size={16} /> Saved — used in your next
            outreach.
          </span>
        )}
      </div>
    </main>
  );
}
