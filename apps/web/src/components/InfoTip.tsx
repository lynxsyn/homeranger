/**
 * InfoTip — a small "i" button that reveals an explanatory popover on click (a
 * faithful TS port of the claude.ai/design handoff, project/app/components.jsx).
 * The popover closes on an outside mousedown or Escape; the wrapper swallows its
 * own clicks so an InfoTip can sit inside a clickable card or row without firing
 * the parent's handler.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export interface InfoTipProps {
  children: ReactNode;
  /** Accessible label for the trigger button (and its aria-label). */
  label?: string;
  /** Which edge the popover anchors to. */
  align?: "left" | "right";
  /** Icon size in px. */
  size?: number;
}

export function InfoTip({
  children,
  label = "More information",
  align = "left",
  size = 15,
}: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="infotip" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`infotip__btn${open ? " is-open" : ""}`}
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Icon name="info" size={size} />
      </button>
      {open && (
        <span className={`infotip__pop infotip__pop--${align}`} role="tooltip">
          {children}
        </span>
      )}
    </span>
  );
}
