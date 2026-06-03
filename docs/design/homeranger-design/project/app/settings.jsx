/* global React, Icon, Button */
const { useState: useS, useEffect: useE, useRef: useR } = React;

/* ---- Profile model + helpers (shared with the outreach drafts) ----------- */
const URGENCY_LEVELS = [
  {
    id: "browsing",
    label: "Keeping an eye out",
    note: "No rush — I just want to know what's coming up.",
    line: "",
  },
  {
    id: "active",
    label: "Actively looking",
    note: "Searching in earnest and happy to view at short notice.",
    line: "I'm actively looking at the moment and can arrange a viewing at short notice.",
  },
  {
    id: "ready",
    label: "Ready to move",
    note: "Finances are in place — I can proceed quickly on the right home.",
    line: "I'm in a strong position to proceed: my finances are in place and I can move quickly for the right place.",
  },
  {
    id: "soon",
    label: "Need to move soon",
    note: "Working to a timeline and need to find somewhere before long.",
    line: "I'm working to a timeline and need to find the right home before long, so I'd be grateful to hear about anything suitable as early as you can.",
  },
];

const BLANK_PROFILE = { firstName: "", lastName: "", phone: "", urgency: "active" };

function getProfile() {
  try {
    const raw = localStorage.getItem("hs-profile");
    if (raw) return { ...BLANK_PROFILE, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...BLANK_PROFILE };
}

function fullName(p) {
  return [p.firstName, p.lastName].map((s) => (s || "").trim()).filter(Boolean).join(" ");
}

function urgencyLine(p) {
  const u = URGENCY_LEVELS.find((x) => x.id === p.urgency);
  return u ? u.line : "";
}

/* The sign-off as it appears at the foot of every outreach email. */
function signatureBlock(p) {
  const name = fullName(p);
  if (!name && !p.phone) return "Many thanks";
  const lines = ["Many thanks,"];
  if (name) lines.push(name);
  if (p.phone) lines.push((p.phone || "").trim());
  return lines.join("\n");
}

/* ---- Header avatar ------------------------------------------------------- */
function Avatar({ profile, active, onClick }) {
  const initials = [profile.firstName, profile.lastName]
    .map((s) => (s || "").trim()[0])
    .filter(Boolean)
    .join("")
    .toUpperCase();
  return (
    <button
      className="avatar-btn"
      aria-current={active}
      onClick={onClick}
      aria-label="Your details"
      title="Your details"
    >
      {initials || <Icon name="user" size={18} />}
    </button>
  );
}

/* ---- Header account menu (nav + theme live here) ------------------------- */
function UserMenu({ profile, tab, theme, onNavigate, onToggleTheme }) {
  const [open, setOpen] = useS(false);
  const wrapRef = useR(null);

  useE(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const name = fullName(profile);
  const urgency = URGENCY_LEVELS.find((u) => u.id === profile.urgency);
  const NAV = [
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  const isDark = theme === "dark";

  function go(id) { onNavigate(id); setOpen(false); }

  return (
    <div className="usermenu" ref={wrapRef}>
      <Avatar profile={profile} active={open || tab === "settings"} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div className="usermenu__pop" role="menu" aria-label="Account">
          <div className="um-head">
            <span className="um-name">{name || "Your account"}</span>
            <span className="um-sub">{name ? (urgency ? urgency.label : "Set up your details") : "Add your name & phone"}</span>
          </div>
          <div className="um-group">
            {NAV.map((n) => (
              <button key={n.id} role="menuitem"
                className={`um-item${tab === n.id ? " is-active" : ""}`}
                onClick={() => go(n.id)}>
                <Icon name={n.icon} size={17} />
                <span>{n.label}</span>
                {tab === n.id && <Icon name="check" size={15} className="um-check" />}
              </button>
            ))}
          </div>
          <div className="um-divider" />
          <button role="menuitem" className="um-item um-theme" onClick={onToggleTheme}>
            <Icon name={isDark ? "sun" : "moon"} size={17} />
            <span>Theme</span>
            <span className="um-theme-state">{isDark ? "Dark" : "Light"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- Settings screen ----------------------------------------------------- */
function SettingsScreen({ profile, onSave, sending, onToggleSending }) {
  const [draft, setDraft] = useS(() => ({ ...profile }));
  const [saved, setSaved] = useS(false);
  const firstRef = useR(null);

  useE(() => { if (firstRef.current) firstRef.current.focus(); }, []);

  const set = (k, v) => { setDraft((d) => ({ ...d, [k]: v })); setSaved(false); };
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);

  function save() {
    onSave(draft);
    setSaved(true);
  }

  const previewProfile = draft;
  const uLine = urgencyLine(previewProfile);

  return (
    <div className="settings">
      <div className="settings-section">
        <span className="settings-eyebrow">Outreach</span>
        <OutreachStatus sending={sending} onToggle={onToggleSending} />
      </div>

      <div className="settings-section">
        <span className="settings-eyebrow">Your details</span>
        <div className="settings-grid">
        <div className="hs-card settings-card">
          <div className="field-row">
            <label className="hs-field">
              <span>First name</span>
              <input
                ref={firstRef}
                className="hs-input"
                placeholder="Jane"
                value={draft.firstName}
                onChange={(e) => set("firstName", e.target.value)}
              />
            </label>
            <label className="hs-field">
              <span>Last name</span>
              <input
                className="hs-input"
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
              placeholder="07700 900123"
              value={draft.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
            <p className="field-hint">
              <Icon name="phone" size={13} /> Added to your sign-off so agents can reach you
              directly. Leave blank to keep it email-only.
            </p>
          </label>

          <div className="hs-field">
            <span>How urgently you're looking</span>
            <div className="urgency-list">
              {URGENCY_LEVELS.map((u) => (
                <button
                  key={u.id}
                  type="button"
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
              <Icon name="sparkles" size={13} /> Sets the tone of your outreach — from a relaxed
              note to a clear signal that you're ready to act.
            </p>
          </div>
        </div>

        <div className="sig-card" aria-live="polite">
          <div className="sig-card__head">
            <Icon name="mail" size={14} /> How this reads to agents
          </div>
          <div className="sig-block">
            <p className="sig-label">Your sign-off</p>
            <pre className="sig-body">{signatureBlock(previewProfile)}</pre>
          </div>
          <div className="sig-block">
            <p className="sig-label">Urgency line in your emails</p>
            {uLine ? (
              <pre className="sig-body">{uLine}</pre>
            ) : (
              <p className="sig-body sig-body--muted">
                No urgency line added — your emails stay relaxed and open-ended.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="settings-foot">
        <Button variant="primary" icon="check" disabled={!dirty} onClick={save}>
          Save details
        </Button>
        {saved && !dirty && (
          <span className="saved-note">
            <Icon name="shield-check" size={16} /> Saved — used in your next outreach.
          </span>
        )}
      </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  URGENCY_LEVELS, getProfile, fullName, urgencyLine, signatureBlock, Avatar, UserMenu, SettingsScreen,
  BLANK_PROFILE,
});
