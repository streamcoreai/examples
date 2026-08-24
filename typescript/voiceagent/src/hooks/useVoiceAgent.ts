"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  StreamCoreAIClient,
  type ConnectionStatus,
  type TranscriptEntry,
  type StreamCoreAIConfig,
} from "@streamcore/js-sdk";

export type { ConnectionStatus, TranscriptEntry };

export interface UseStreamCoreAIReturn {
  status: ConnectionStatus;
  transcript: TranscriptEntry[];
  audioLevel: number;
  isMuted: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  toggleMute: () => void;
}

export function useStreamCoreAI(config?: StreamCoreAIConfig): UseStreamCoreAIReturn {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const clientRef = useRef<StreamCoreAIClient | null>(null);

  // Lazily create the SDK client once.
  const getClient = useCallback(() => {
    if (!clientRef.current) {
      clientRef.current = new StreamCoreAIClient(config, {
        onTranscript: (_entry, all) => setTranscript([...all]),
        onStatusChange: (s) => {
          setStatus(s);
          setLocalStream(clientRef.current?.localStream || null);
          setRemoteStream(clientRef.current?.remoteStream || null);
        },
        onAudioLevel: (level) => setAudioLevel(level),
        onError: (err) => console.error("[streamcoreai]", err),
      });
    }
    return clientRef.current;
  }, [config]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  const connect = useCallback(async () => {
    await getClient().connect();
  }, [getClient]);

  const disconnect = useCallback(() => {
    getClient().disconnect();
  }, [getClient]);

  const toggleMute = useCallback(() => {
    const client = getClient();
    client.toggleMute();
    setIsMuted(client.isMuted);
  }, [getClient]);

  return {
    status,
    transcript,
    audioLevel,
    isMuted,
    localStream,
    remoteStream,
    connect,
    disconnect,
    toggleMute,
  };
}
