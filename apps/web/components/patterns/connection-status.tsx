"use client";

import type { ConnectionState } from "@/lib/api";
import { cn } from "@/lib/utils";

const states = {
  live: { label: "Live", dot: "bg-[var(--success)]" },
  reconnecting: { label: "Reconnecting", dot: "bg-[var(--warning)]" },
  offline: { label: "Offline", dot: "bg-[var(--text-muted)]" },
} satisfies Record<ConnectionState, { label: string; dot: string }>;

export function ConnectionStatus({ state, compact = false }: { state: ConnectionState; compact?: boolean }) {
  const config = states[state];
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2.5 text-xs font-medium text-[var(--text-secondary)]" role="status" aria-live="polite">
      <span className={cn("size-1.5 rounded-full", config.dot, state === "live" && "pulse-dot")} />
      {!compact && config.label}
    </span>
  );
}
