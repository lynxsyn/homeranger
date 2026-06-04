/**
 * CoverageCell — the Agents table's Coverage column. Ported from the
 * claude.ai/design handoff (project/app/agents.jsx: CoverageCell), adapted to
 * the real AgentRow, which carries `outcodes` (= Agent.coveredOutcodes) rather
 * than the prototype's `coverage` + `scoutName` — so there is no search-name
 * subline here.
 *
 * Postcode letters are a sorting code, not a place. A wide patch rolls up to its
 * dominant county/region + a count ("Gwynedd · 5 outcodes") on ONE fixed-height
 * line, with the town-by-town breakdown (HQ marked) in a click-to-open popover.
 * A single-outcode agent reads as its town + the code, with no popover. The
 * fixed-height summary is what stops the row growing with the patch.
 *
 * The popover is PORTALED to document.body and positioned `fixed`: the table
 * wrapper has `overflow:hidden`, which would clip an in-cell popover. It closes
 * on outside mousedown, Escape, or any scroll/resize (which would strand it) —
 * the same interaction contract as the design prototype.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { coverageSummary } from "../lib/coverage";

export interface CoverageCellProps {
  /** The agent's covered outcodes (= AgentRow.outcodes / Agent.coveredOutcodes). */
  outcodes: string[];
}

/** Fixed-position rect for the portaled popover (top XOR bottom anchored). */
interface PopPosition {
  left: number;
  top: number | null;
  bottom: number | null;
  maxHeight: number;
}

export function CoverageCell({ outcodes }: CoverageCellProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPosition | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const s = useMemo(() => coverageSummary(outcodes), [outcodes]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Anchor the popover to the trigger, flipping above it when there is more
    // room up than down (a row near the viewport bottom).
    const place = () => {
      const el = triggerRef.current;
      if (!el) {
        return;
      }
      const r = el.getBoundingClientRect();
      const margin = 12;
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(160, openUp ? spaceAbove : spaceBelow);
      setPos({
        left: r.left,
        top: openUp ? null : r.bottom + 6,
        bottom: openUp ? window.innerHeight - r.top + 6 : null,
        maxHeight,
      });
    };
    place();

    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // Return focus to the trigger (role="dialog" keyboard-dismiss contract).
        triggerRef.current?.focus();
      }
    };
    const onScroll = () => setOpen(false);

    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  // One outcode (or none) — show its town + the code, no rollup needed.
  if (s.count <= 1) {
    return (
      <div className="cov-cell" data-testid="agent-coverage">
        <span className="cov-static">
          <Icon name="map-pin" size={13} />
          <span className="cov-static__town">{s.primaryTown ?? "—"}</span>
          {s.primary && <span className="sf-oc">{s.primary}</span>}
        </span>
      </div>
    );
  }

  const popover =
    open && pos
      ? createPortal(
          <div
            className="cov-pop"
            role="dialog"
            aria-label="Coverage detail"
            ref={popRef}
            style={{
              left: pos.left,
              top: pos.top ?? "auto",
              bottom: pos.bottom ?? "auto",
              maxHeight: pos.maxHeight,
            }}
          >
            <div className="cov-pop__head">
              Covers <b>{s.count} outcodes</b> around {s.regions.join(", ")}
            </div>
            <div className="cov-pop__groups">
              {s.towns.map((town) => (
                <div className="cov-grp" key={town}>
                  <span className="cov-grp__area">{town}</span>
                  <div className="cov-grp__chips">
                    {(s.groups[town] ?? []).map((oc) => (
                      <span
                        key={oc}
                        className={`sf-oc${oc === s.primary ? " is-primary" : ""}`}
                      >
                        {oc === s.primary && (
                          <i className="cov-hq" aria-hidden="true" />
                        )}
                        {oc}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {s.primary && (
              <div className="cov-pop__foot">
                <i className="cov-hq" aria-hidden="true" /> Head office ·{" "}
                {s.primaryTown} ({s.primary})
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className="cov-cell cov-cell--roll"
      ref={wrapRef}
      data-testid="agent-coverage"
    >
      <button
        type="button"
        ref={triggerRef}
        className={`cov-roll${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-label={`Coverage: ${s.count} outcodes around ${s.region ?? "multiple areas"}`}
        data-testid="agent-coverage-roll"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="map-pin" size={13} />
        <span className="cov-roll__area">{s.region}</span>
        <span className="cov-roll__sep" aria-hidden="true">
          ·
        </span>
        <span className="cov-roll__count">{s.count} outcodes</span>
        <Icon name="chevron-down" size={13} />
      </button>
      {popover}
    </div>
  );
}
