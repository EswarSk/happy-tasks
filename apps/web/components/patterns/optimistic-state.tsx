import { AlertTriangle, Check, LoaderCircle, RefreshCcw } from "lucide-react";
import type { SyncState } from "@/lib/api";

export function OptimisticStateIndicator({ state = "synced" }: { state?: SyncState }) {
  if (state === "synced") return <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]"><Check className="size-3" />Saved</span>;
  if (state === "pending") return <span className="inline-flex items-center gap-1 text-xs text-indigo-600"><LoaderCircle className="size-3 animate-spin" />Saving</span>;
  if (state === "conflict") return <span className="inline-flex items-center gap-1 text-xs text-amber-700"><RefreshCcw className="size-3" />Conflict</span>;
  return <span className="inline-flex items-center gap-1 text-xs text-rose-700"><AlertTriangle className="size-3" />Not saved</span>;
}
