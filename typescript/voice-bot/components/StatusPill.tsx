import type { ConnectionStatus } from "@streamcore/js-sdk";
import type { AgentState } from "@streamcore/js-sdk";

const LABELS: Record<ConnectionStatus, string> = {
  idle: "Offline",
  connecting: "Connecting",
  connected: "Live",
  reconnecting: "Reconnecting",
  error: "Error",
  disconnected: "Disconnected",
};

const AGENT_LABELS: Record<AgentState, string> = {
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const TONES: Record<ConnectionStatus, string> = {
  idle: "text-white/45 bg-white/5",
  connecting: "text-glow bg-glow/10",
  connected: "text-glow bg-glow/10",
  reconnecting: "text-violet bg-violet/10",
  error: "text-alert bg-alert/10",
  disconnected: "text-white/45 bg-white/5",
};

export function StatusPill({ status, agentState }: { status: ConnectionStatus; agentState: AgentState }) {
  const live = status === "connected";
  const label = live ? AGENT_LABELS[agentState] : LABELS[status];
  const busy = status === "connecting" || status === "reconnecting";

  return (
    <div
      className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium tracking-wide ${TONES[status]}`}
    >
      <span className="relative flex size-1.5">
        <span className={`size-1.5 rounded-full bg-current ${busy ? "animate-pulse" : ""}`} />
        {live && <span className="pulse-ring absolute inset-0" />}
      </span>
      {label}
    </div>
  );
}
