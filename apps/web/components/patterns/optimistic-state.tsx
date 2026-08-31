import { AlertTriangle, Check, LoaderCircle, RefreshCcw } from "lucide-react";
import type { SyncState } from "@/lib/api";

export function OptimisticStateIndicator({ state = "synced" }: { state?: SyncState }) {
  if (state === "synced") return <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]"><Check className="size-3" />Saved</span>;
  if (state === "pending") return <span className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]"><LoaderCircle className="size-3 animate-spin" />Pending</span>;
  if (state === "conflict") return <span className="inline-flex items-center gap-1 text-xs text-[var(--warning-text)]"><RefreshCcw className="size-3" />Conflict</span>;
  return <span className="inline-flex items-center gap-1 text-xs text-[var(--danger-text)]"><AlertTriangle className="size-3" />Not saved</span>;
}
