interface IconProps {
  className?: string;
}

const base = "h-[18px] w-[18px]";

export function MicIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

export function MicOffIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}>
      <path d="M9 9V6a3 3 0 0 1 6 0v5M15 15a3 3 0 0 1-6-2.5" strokeLinecap="round" />
      <path d="M5 11a7 7 0 0 0 10.9 5.8M19 11v.5M12 18v3" strokeLinecap="round" />
      <path d="m4 4 16 16" strokeLinecap="round" />
    </svg>
  );
}

export function HangUpIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}>
      <path
        d="M3.2 12.6c4.8-4.8 12.8-4.8 17.6 0l-2 2a2 2 0 0 1-2.6.2l-1.5-1.1a1 1 0 0 1-.4-.8v-1.6a10 10 0 0 0-4.6 0v1.6a1 1 0 0 1-.4.8L7.8 14.8a2 2 0 0 1-2.6-.2z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TranscriptIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M7 9.5h7M7 13h10M7 16h4" strokeLinecap="round" />
    </svg>
  );
}

export function GaugeIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}>
      <path d="M4 17a8 8 0 1 1 16 0" strokeLinecap="round" />
      <path d="m12 17 4-5" strokeLinecap="round" />
    </svg>
  );
}

/** Points up by default; the pad rotates it for the other three. */
export function ArrowIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className}>
      <path d="M12 19V6M6.5 11.5 12 5.6l5.5 5.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RecentreIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2" strokeLinecap="round" />
    </svg>
  );
}

export function RoomIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}>
      <path d="M12 3.2 20.5 8v8L12 20.8 3.5 16V8z" strokeLinejoin="round" />
      <path d="M12 3.2V12m0 0 8.5-4M12 12l-8.5-4" strokeLinejoin="round" />
    </svg>
  );
}
