"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StreamCoreAIClient,
  type AgentState,
  type ConnectionStatus,
  type ReconnectEvent,
  type StreamCoreAIConfig,
  type TimingEvent,
  type TranscriptEntry,
} from "@streamcore/js-sdk";

import { describeConnectError, diagnoseConnectError } from "@/lib/diagnoseConnection";
import { MOVEMENT_COMMAND_TOPIC, parseMovementCommand } from "@/lib/bot/movementCommand";
import { BOT_GESTURE_TOPIC, parseGesture } from "@/lib/bot/gesture";
import type { AudioLevels, BotAction } from "@/lib/bot/botScene";
import type { Expression } from "@/lib/bot/expression";

export interface VoiceAgent {
  status: ConnectionStatus;
  agentState: AgentState;
  expression: Expression;
  transcript: TranscriptEntry[];
  timings: TimingEvent[];
  reconnect: ReconnectEvent | null;
  error: string | null;
  muted: boolean;
  /** True once a connect attempt has been sitting there long enough to be suspicious. */
  slowConnect: boolean;
  /** Where the SDK is dialling, so a stuck connect can say what it is waiting for. */
  whipUrl: string;
  /** Live audio envelopes. A ref, because the bot reads them every frame. */
  levels: { current: AudioLevels };
  /** Movement the agent has asked for, drained by the scene each frame. */
  commands: { current: BotAction[] };
  connect: () => Promise<void>;
  disconnect: () => void;
  toggleMute: () => void;
  dismissError: () => void;
}

function expressionFor(status: ConnectionStatus, agentState: AgentState): Expression {
  switch (status) {
    case "idle":
    case "disconnected":
      return "offline";
    case "connecting":
      return "boot";
    case "reconnecting":
      return "thinking";
    case "error":
      return "error";
    case "connected":
      return agentState;
  }
}

export function useVoiceAgent(): VoiceAgent {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [agentState, setAgentState] = useState<AgentState>("listening");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [timings, setTimings] = useState<TimingEvent[]>([]);
  const [reconnect, setReconnect] = useState<ReconnectEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [slowConnect, setSlowConnect] = useState(false);

  const levels = useRef<AudioLevels>({ user: 0, agent: 0 });
  const commands = useRef<BotAction[]>([]);
  const clientRef = useRef<StreamCoreAIClient | null>(null);
  const analyser = useRef<AgentAnalyser | null>(null);
  /**
   * When a connect is cancelled, the attempt can still fail asynchronously
   * inside the SDK — an in-flight getUserMedia resolves against a peer
   * connection that disconnect() has already closed. The user asked for it to
   * stop; they should not then be shown an error about it stopping.
   */
  const cancelledAt = useRef(0);

  const config = useMemo<StreamCoreAIConfig>(
    () => ({
      whipUrl: process.env.NEXT_PUBLIC_WHIP_URL || "http://localhost:8080/whip",
      tokenUrl: process.env.NEXT_PUBLIC_TOKEN_URL || undefined,
      apiKey: process.env.NEXT_PUBLIC_API_KEY || undefined,
    }),
    []
  );

  const getClient = useCallback(() => {
    if (clientRef.current) return clientRef.current;

    clientRef.current = new StreamCoreAIClient(config, {
      onStatusChange: (next) => {
        if (next !== "connecting") setSlowConnect(false);
        if (next === "error" && Date.now() - cancelledAt.current < 3000) {
          setStatus("idle");
          return;
        }
        setStatus(next);
        if (next === "connected") {
          setError(null);
          // ontrack usually beats the connected event, but not always.
          analyser.current?.attachWhenReady(() => clientRef.current?.remoteStream ?? null);
        }
        if (next === "idle" || next === "disconnected" || next === "error") {
          analyser.current?.detach();
          levels.current.agent = 0;
          levels.current.user = 0;
        }
      },
      onAgentStateChange: setAgentState,
      /**
       * What the model asked the bot to do: `movement.*` drives the feet, `bot.*`
       * poses the arms and head. The server turns both into these packets and
       * does not wait for us — it has already told the model they succeeded —
       * so there is nothing to reply to, only a queue for the scene to pick up
       * on its next frame.
       */
      onData: (topic, payload) => {
        let action: BotAction | null = null;
        if (topic === MOVEMENT_COMMAND_TOPIC) {
          const command = parseMovementCommand(payload);
          if (command) action = { type: "drive", command };
        } else if (topic === BOT_GESTURE_TOPIC) {
          const gesture = parseGesture(payload);
          if (gesture) action = { type: "gesture", gesture };
        } else {
          return;
        }
        if (action) commands.current.push(action);
        else console.warn("[voice-bot] ignoring malformed", topic, "payload");
      },
      onTranscript: (_entry, all) => setTranscript([...all]),
      onAudioLevel: (level) => {
        levels.current.user = level;
      },
      onTiming: (event) => setTimings((previous) => [...previous.slice(-11), event]),
      onReconnect: (event) => {
        setReconnect(event);
        if (event.outcome === "recovered-without-history") {
          setError("Reconnected, but the agent lost the earlier conversation.");
        }
        if (event.outcome === "failed" && event.attempt === event.maxAttempts) {
          setError("Lost the connection and could not get it back.");
        }
      },
      onError: (err) => {
        console.error("[voice-bot]", err);
        if (Date.now() - cancelledAt.current < 3000) return;
        const target = { whipUrl: config.whipUrl ?? "", tokenUrl: config.tokenUrl };
        setError(describeConnectError(err, target));
        // Probing takes a round trip, so the first message goes up immediately
        // and gets replaced if the probe learns something better.
        void diagnoseConnectError(err, target).then((refined) => {
          if (refined && Date.now() - cancelledAt.current >= 3000) setError(refined);
        });
      },
    });
    return clientRef.current;
  }, [config]);

  useEffect(() => {
    analyser.current = new AgentAnalyser(levels);
    return () => {
      analyser.current?.dispose();
      clientRef.current?.disconnect();
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setTimings([]);
    cancelledAt.current = 0;
    await getClient().connect();
  }, [getClient]);

  const disconnect = useCallback(() => {
    cancelledAt.current = Date.now();
    // Anything still queued was asked for by a call that is now over.
    commands.current.length = 0;
    getClient().disconnect();
    setAgentState("listening");
    setSlowConnect(false);
    setReconnect(null);
  }, [getClient]);

  // A connect that has not resolved by now is not slow, it is stuck — usually
  // no server on the other end, or a microphone another app has not let go of.
  useEffect(() => {
    if (status !== "connecting") return;
    const timer = setTimeout(() => setSlowConnect(true), 9000);
    return () => clearTimeout(timer);
  }, [status]);

  const toggleMute = useCallback(() => {
    const client = getClient();
    client.toggleMute();
    setMuted(client.isMuted);
    if (client.isMuted) levels.current.user = 0;
  }, [getClient]);

  return {
    status,
    agentState,
    expression: expressionFor(status, agentState),
    transcript,
    timings,
    reconnect,
    error,
    muted,
    slowConnect,
    whipUrl: config.whipUrl ?? "",
    levels,
    commands,
    connect,
    disconnect,
    toggleMute,
    dismissError: useCallback(() => setError(null), []),
  };
}

/**
 * Measures how loudly the agent is talking.
 *
 * The SDK reports the microphone level but not the far end, and the bot's mouth
 * needs the far end. Tapping the remote MediaStream works because the SDK has
 * already attached it to an audio element — a MediaStreamAudioSourceNode on its
 * own does not pull frames in Chrome.
 */
class AgentAnalyser {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AnalyserNode | null = null;
  private frame = 0;
  private poll = 0;
  private readonly buffer = new Uint8Array(1024);

  constructor(private readonly levels: { current: AudioLevels }) {}

  attachWhenReady(resolve: () => MediaStream | null) {
    if (this.source) return;
    let waited = 0;
    clearInterval(this.poll);
    this.poll = window.setInterval(() => {
      const stream = resolve();
      waited += 120;
      if (stream) {
        clearInterval(this.poll);
        this.attach(stream);
      } else if (waited > 6000) {
        clearInterval(this.poll);
      }
    }, 120);
  }

  private attach(stream: MediaStream) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Ctor();
    void context.resume();

    const node = context.createAnalyser();
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0.35;

    this.context = context;
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(node);
    this.node = node;

    const tick = () => {
      if (!this.node) return;
      this.node.getByteTimeDomainData(this.buffer);
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i++) {
        const v = (this.buffer[i] - 128) / 128;
        sum += v * v;
      }
      // RMS rather than an FFT average: it tracks a speech envelope far more
      // closely, which is what the mouth is following.
      this.levels.current.agent = Math.min(1, Math.sqrt(sum / this.buffer.length) * 2.6);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  detach() {
    clearInterval(this.poll);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.source?.disconnect();
    this.source = null;
    this.node = null;
    void this.context?.close();
    this.context = null;
    this.levels.current.agent = 0;
  }

  dispose() {
    this.detach();
  }
}
