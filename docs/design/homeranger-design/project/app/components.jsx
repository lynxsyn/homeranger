/* global React */
// HomeRanger — shared primitives. Exported to window for cross-file use.
const { useRef, useLayoutEffect } = React;

/* ---- Icon: faithful Lucide injection (keeps the <svg> React-owned) ------- */
function pascal(name) {
  return name.split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
}
function Icon({ name, size = 18, strokeWidth = 1.75, className = "", style }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = window.lucide && window.lucide.icons[pascal(name)];
    if (node && ref.current) {
      ref.current.innerHTML = node
        .map(
          ([tag, attrs]) =>
            `<${tag} ${Object.entries(attrs)
              .map(([k, v]) => `${k}="${v}"`)
              .join(" ")} />`,
        )
        .join("");
    }
  }, [name]);
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", flexShrink: 0, ...style }}
      aria-hidden="true"
    />
  );
}

/* ---- Logo lockup --------------------------------------------------------- */
function Logo({ size = 30, showWord = true, light = false }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <img
        src="assets/logo-mark.svg"
        width={size}
        height={size}
        alt="HomeRanger"
        style={{ display: "block" }}
      />
      {showWord && (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: size * 0.62,
            letterSpacing: "-0.02em",
            color: light ? "#fff" : "var(--ink-1)",
          }}
        >
          Home<span style={{ color: light ? "#BFE3CE" : "var(--accent)" }}>Ranger</span>
        </span>
      )}
    </span>
  );
}

/* ---- Button -------------------------------------------------------------- */
function Button({ variant = "primary", size, icon, children, ...rest }) {
  const cls = [
    "hs-btn",
    `hs-btn--${variant}`,
    size === "sm" ? "hs-btn--sm" : "",
    !children ? "hs-btn--icon" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} {...rest}>
      {icon && <Icon name={icon} size={children ? 16 : 18} />}
      {children}
    </button>
  );
}

/* ---- Chip ---------------------------------------------------------------- */
function Chip({ icon, accent, children }) {
  return (
    <span className={`hs-chip${accent ? " hs-chip--accent" : ""}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

/* ---- Status badge -------------------------------------------------------- */
const STATUS_META = {
  live: { cls: "live", label: "Live", dot: true },
  under_offer: { cls: "offer", label: "Under offer", dot: true },
  sold: { cls: "sold", label: "Sold", dot: true },
  withdrawn: { cls: "withdrawn", label: "Withdrawn", dot: true },
};
function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.live;
  return (
    <span className={`hs-badge hs-badge--${m.cls}${m.dot ? " hs-badge--dot" : ""}`}>
      {m.label}
    </span>
  );
}

/* ---- EPC band ------------------------------------------------------------ */
function EpcBadge({ band }) {
  if (!band || band === "unknown") return null;
  return (
    <span className="hs-epc" data-band={band} title={`EPC rating ${band.toUpperCase()}`}>
      {band.toUpperCase()}
    </span>
  );
}

/* ---- Match-score ring ---------------------------------------------------- */
function ScoreRing({ value, size = 38 }) {
  const pending = value == null;
  return (
    <div
      className="hs-score__ring"
      style={{
        "--val": pending ? 0 : value,
        "--size": `${size}px`,
        background: pending ? "var(--surface-3)" : undefined,
      }}
    >
      <span className="hs-score__num" style={{ color: pending ? "var(--ink-3)" : undefined }}>
        {pending ? "–" : value}
      </span>
    </div>
  );
}
function scoreLabel(v) {
  if (v == null) return "Not analysed";
  if (v >= 85) return "Excellent match";
  if (v >= 70) return "Strong match";
  if (v >= 50) return "Fair match";
  return "Weak match";
}

/* ---- Photo placeholder (image-glyph tile) -------------------------------- */
function Photo({ count, style, className = "" }) {
  return (
    <div className={`hs-photo ${className}`} style={style}>
      <Icon name="image" size={32} />
      {count != null && (
        <span className="hs-photo__count">
          <Icon name="images" size={12} />
          {count}
        </span>
      )}
    </div>
  );
}

/* ---- Info tip: small "i" that explains on click ------------------------- */
function InfoTip({ children, label = "More information", align = "left", size = 15 }) {
  const [open, setOpen] = React.useState(false);
  const wrap = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <span className="infotip" ref={wrap} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`infotip__btn${open ? " is-open" : ""}`}
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <Icon name="info" size={size} />
      </button>
      {open && (
        <span className={`infotip__pop infotip__pop--${align}`} role="tooltip">{children}</span>
      )}
    </span>
  );
}

Object.assign(window, {
  Icon, Logo, Button, Chip, StatusBadge, EpcBadge, ScoreRing, scoreLabel, Photo, STATUS_META, InfoTip,
});
