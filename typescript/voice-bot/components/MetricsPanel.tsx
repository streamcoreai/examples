"use client";

import type { ReconnectEvent, TimingEvent } from "@streamcore/js-sdk";

interface MetricsPanelProps {
  timings: TimingEvent[];
  reconnect: ReconnectEvent | null;
}

export function MetricsPanel({ timings, reconnect }: MetricsPanelProps) {
  // Only the most recent value per stage is interesting; the SDK emits one
  // event per stage per turn.
  const latest = new Map<string, number>();
  for (const event of timings) latest.set(event.stage, event.ms);
  const rows = [...latest.entries()];

  return (
    <div className="glass pointer-events-auto w-56 rounded-2xl px-4 py-3">
      <h2 className="mb-2 font-mono text-[11px] tracking-widest text-white/40 uppercase">Pipeline</h2>

      {rows.length === 0 ? (
        <p className="text-[12px] text-white/30">Timings appear after the first turn.</p>
      ) : (
        <dl className="space-y-1.5">
          {rows.map(([stage, ms]) => (
            <div key={stage} className="flex items-baseline justify-between gap-3">
              <dt className="truncate text-[12px] text-white/50">{stage}</dt>
              <dd
                className={`font-mono text-[12px] tabular-nums ${
                  ms > 1200 ? "text-alert" : ms > 600 ? "text-violet" : "text-glow"
                }`}
              >
                {Math.round(ms)}ms
              </dd>
            </div>
          ))}
        </dl>
      )}

      {reconnect && reconnect.outcome !== "recovered" && (
        <p className="mt-3 border-t hairline pt-2 font-mono text-[11px] text-violet">
          {reconnect.phase} {reconnect.attempt}/{reconnect.maxAttempts} — {reconnect.outcome}
        </p>
      )}
    </div>
  );
}
