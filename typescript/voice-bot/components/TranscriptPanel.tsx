"use client";

import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "@streamcore/js-sdk";

export function TranscriptPanel({ transcript }: { transcript: TranscriptEntry[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * Whether to keep following new turns. Someone who has scrolled up is reading
   * something, and yanking them back to the bottom every time a partial
   * transcript updates — which is several times a second while a turn is being
   * recognised — makes that impossible.
   */
  const following = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !following.current) return;
    // Set scrollTop rather than scrollIntoView: the panel floats in an overlay
    // above the canvas, and scrollIntoView is free to scroll any ancestor it
    // likes to satisfy the request.
    list.scrollTop = list.scrollHeight;
  }, [transcript]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  };

  return (
    <div className="glass pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-2xl">
      <header className="flex shrink-0 items-center justify-between border-b hairline px-4 py-3">
        <h2 className="font-mono text-[11px] tracking-widest text-white/40 uppercase">Transcript</h2>
        <span className="font-mono text-[11px] text-white/25">{transcript.length}</span>
      </header>

      {/* min-h-0 is what makes this scroll instead of stretching its parent. */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4"
      >
        {transcript.length === 0 && (
          <p className="text-[13px] leading-relaxed text-white/30">
            Nothing said yet. Start the conversation and speak — turns appear here as they are
            recognised.
          </p>
        )}

        {transcript.map((entry, index) => (
          <div key={index} className="rise space-y-1">
            <span
              className={`font-mono text-[10px] tracking-widest uppercase ${
                entry.role === "user" ? "text-white/35" : "text-glow/70"
              }`}
            >
              {entry.role === "user" ? "You" : "Bot"}
            </span>
            <p
              className={`text-[13.5px] leading-relaxed ${
                entry.partial ? "text-white/45 italic" : "text-white/85"
              }`}
            >
              {entry.text}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
