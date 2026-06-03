/**
 * OutreachStatus — the global outreach send control (Settings → Outreach). A
 * faithful port of the claude.ai/design handoff's calm "is it sending?" bar:
 * a live/paused indicator, a warm-up meter (sends today vs the daily cap), and
 * the kill-switch toggle. Operator-only: it reads `outreach.killSwitch.get` +
 * `outreach.warmup` and flips `outreach.killSwitch.toggle`.
 *
 * `enabled` (WarmupState.killSwitch ON) means sending is PAUSED, so
 * `sending = !enabled`. The toggle's `is-on` / `aria-checked` reflect PAUSED
 * (i.e. `enabled`), matching the design's inverted knob.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { trpc } from "../lib/trpc";
import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";

export function OutreachStatus() {
  const utils = trpc.useUtils();
  const { data: killSwitch } = trpc.outreach.killSwitch.get.useQuery();
  const { data: warmup } = trpc.outreach.warmup.useQuery();
  const toggle = trpc.outreach.killSwitch.toggle.useMutation({
    onSuccess: () => {
      void utils.outreach.killSwitch.get.invalidate();
    },
  });

  // Treat loading as "not paused" so the control reads safe-by-default (live).
  const enabled = killSwitch?.enabled ?? false;
  const sending = !enabled;
  const today = warmup?.sentToday ?? 0;
  const cap = warmup?.dailyCap ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((today / cap) * 100)) : 0;

  return (
    <div
      className={`outreach-bar${sending ? "" : " is-paused"}`}
      data-testid="kill-switch"
      data-enabled={enabled}
    >
      <span className="ob-icon">
        <Icon name={sending ? "radar" : "power"} size={20} />
      </span>
      <div className="ob-copy">
        <span className="ob-title" data-testid="kill-switch-state">
          {sending ? "Outreach is sending live" : "Outreach paused"}
          <span className="ob-pulse" aria-hidden="true" />
          <InfoTip label="What outreach sending means">
            When this is live, approved outreach goes out to estate agents, paced
            under your daily warm-up cap and checked for compliance. Pause it to
            stop all outbound email at once. Replies still arrive and still become
            listings.
          </InfoTip>
        </span>
      </div>
      <div className="ob-right">
        {sending && (
          <div className="ob-warmup" title={`${today} of ${cap} sent today`}>
            <span className="obw-head">
              <Icon name="trending-up" size={13} /> Warm-up · today
              <InfoTip label="About the warm-up cap" align="right">
                Your daily send cap ramps up gradually to protect deliverability.
                This is how many outreach emails have gone out today against
                today&rsquo;s cap.
              </InfoTip>
            </span>
            <span className="obw-bar">
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="obw-num">
              {today} / {cap}
            </span>
          </div>
        )}
        <button
          type="button"
          className={`killswitch__toggle${sending ? "" : " is-on"}`}
          role="switch"
          aria-checked={enabled}
          aria-label={sending ? "Pause all outreach" : "Resume all outreach"}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ enabled: !enabled })}
        >
          <span className="killswitch__knob" />
        </button>
      </div>
    </div>
  );
}
