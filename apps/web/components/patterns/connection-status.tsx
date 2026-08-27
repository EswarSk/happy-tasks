"use client";

import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import type { ConnectionState } from "@/lib/api";
import { cn } from "@/lib/utils";

const states = {
  live: { label: "Live", Icon: Cloud, styles: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  reconnecting: { label: "Reconnecting", Icon: LoaderCircle, styles: "border-amber-200 bg-amber-50 text-amber-700", dot: "bg-amber-500" },
  offline: { label: "Offline", Icon: CloudOff, styles: "border-slate-200 bg-slate-100 text-slate-600", dot: "bg-slate-400" },
} satisfies Record<ConnectionState, { label: string; Icon: typeof Cloud; styles: string; dot: string }>;

export function ConnectionStatus({ state, compact = false }: { state: ConnectionState; compact?: boolean }) {
  const config = states[state];
  return (
    <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium", config.styles)} role="status" aria-live="polite">
      <span className={cn("size-1.5 rounded-full", config.dot, state === "live" && "pulse-dot")} />
      {!compact && config.label}
    </span>
  );
}
