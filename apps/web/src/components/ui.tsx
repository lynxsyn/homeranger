/**
 * HomeScout UI primitives — a faithful React/TS port of the claude.ai/design
 * handoff (docs/design/homescout-design/project/app/components.jsx). The visual
 * contract lives in the CSS component layer (src/styles/components.css); these
 * components only emit the right class names + structure.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`;
 * cross-package imports use the bare specifier.
 */
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { ListingStatus } from "@homescout/shared";
import { Icon } from "./Icon";

/* ---- Logo lockup --------------------------------------------------------- */
export interface LogoProps {
  size?: number;
  showWord?: boolean;
  light?: boolean;
}

export function Logo({ size = 30, showWord = true, light = false }: LogoProps) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <img
        src="/logo-mark.svg"
        width={size}
        height={size}
        alt="HomeScout"
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
          Home
          <span style={{ color: light ? "#BFE3CE" : "var(--accent)" }}>Scout</span>
        </span>
      )}
    </span>
  );
}

/* ---- Button -------------------------------------------------------------- */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm";
  icon?: string;
}

export function Button({
  variant = "primary",
  size,
  icon,
  children,
  className,
  ...rest
}: ButtonProps) {
  const cls = [
    "hs-btn",
    `hs-btn--${variant}`,
    size === "sm" ? "hs-btn--sm" : "",
    !children ? "hs-btn--icon" : "",
    className ?? "",
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

/* ---- Chip (metadata pill) ------------------------------------------------ */
export interface ChipProps {
  icon?: string;
  accent?: boolean;
  children: ReactNode;
}

export function Chip({ icon, accent, children }: ChipProps) {
  return (
    <span className={`hs-chip${accent ? " hs-chip--accent" : ""}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

/* ---- Status badge -------------------------------------------------------- */
interface StatusMeta {
  cls: string;
  label: string;
  dot: boolean;
}

export const STATUS_META: Record<ListingStatus, StatusMeta> = {
  pre_market: { cls: "premarket", label: "Pre-market", dot: false },
  live: { cls: "live", label: "Live", dot: true },
  under_offer: { cls: "offer", label: "Under offer", dot: true },
  sold: { cls: "sold", label: "Sold", dot: true },
  withdrawn: { cls: "withdrawn", label: "Withdrawn", dot: true },
};

export function StatusBadge({ status }: { status: ListingStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.live;
  return (
    <span
      className={`hs-badge hs-badge--${meta.cls}${meta.dot ? " hs-badge--dot" : ""}`}
    >
      {meta.label}
    </span>
  );
}

/* ---- EPC band badge ------------------------------------------------------ */
const EPC_BANDS = new Set(["a", "b", "c", "d", "e", "f", "g"]);

export function EpcBadge({ band }: { band: string | null }) {
  if (!band || !EPC_BANDS.has(band)) {
    return null;
  }
  return (
    <span className="hs-epc" data-band={band} title={`EPC rating ${band.toUpperCase()}`}>
      {band.toUpperCase()}
    </span>
  );
}

/* ---- Match-score ring ---------------------------------------------------- */
export interface ScoreRingProps {
  value: number | null;
  size?: number;
}

export function ScoreRing({ value, size = 38 }: ScoreRingProps) {
  const pending = value == null;
  const ringStyle = {
    "--val": pending ? 0 : value,
    "--size": `${size}px`,
    ...(pending ? { background: "var(--surface-3)" } : {}),
  } as CSSProperties;
  return (
    <div className="hs-score__ring" style={ringStyle}>
      <span
        className="hs-score__num"
        style={pending ? { color: "var(--ink-3)" } : undefined}
      >
        {pending ? "–" : value}
      </span>
    </div>
  );
}

export function scoreLabel(value: number | null): string {
  if (value == null) {
    return "Not analysed";
  }
  if (value >= 85) {
    return "Excellent match";
  }
  if (value >= 70) {
    return "Strong match";
  }
  if (value >= 50) {
    return "Fair match";
  }
  return "Weak match";
}

/* ---- Photo placeholder (image-glyph tile) -------------------------------- */
export interface PhotoProps {
  count?: number | null;
  style?: CSSProperties;
  className?: string;
}

export function Photo({ count, style, className = "" }: PhotoProps) {
  return (
    <div className={`hs-photo ${className}`.trim()} style={style}>
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
