"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { offlineWorkspaceApi, type OfflineSyncSnapshot } from "@/lib/api";

const emptySyncSnapshot: OfflineSyncSnapshot = { pending: 0, failed: 0, conflicts: 0, syncing: false };
const subscribeSync = (listener: () => void) => offlineWorkspaceApi?.subscribeOfflineSnapshot(listener) ?? (() => undefined);
const getSyncSnapshot = () => offlineWorkspaceApi?.getOfflineSnapshot() ?? emptySyncSnapshot;

export function PwaRuntime() {
  const queryClient = useQueryClient();
  const online = useSyncExternalStore(
    (onChange) => { window.addEventListener("online", onChange); window.addEventListener("offline", onChange); return () => { window.removeEventListener("online", onChange); window.removeEventListener("offline", onChange); }; },
    () => navigator.onLine,
    () => true,
  );
  const sync = useSyncExternalStore(subscribeSync, getSyncSnapshot, () => emptySyncSnapshot);

  const syncNow = async () => {
    await offlineWorkspaceApi?.syncOfflineChanges();
    await queryClient.invalidateQueries();
  };
  const discardAndLoadServerVersions = async () => {
    if (!window.confirm("Discard the blocked offline changes and load the latest server versions?")) return;
    await offlineWorkspaceApi?.discardBlockedChanges();
    await queryClient.invalidateQueries();
  };

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    void offlineWorkspaceApi?.hydrateOfflineState();
  }, [queryClient]);

  useEffect(() => {
    if (online) void syncNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  if (online && !sync.pending && !sync.failed && !sync.conflicts && !sync.syncing) return null;
  const problemCount = sync.failed + sync.conflicts;
  return <div role="status" aria-live="polite" className={`fixed inset-x-0 bottom-0 z-[100] flex min-h-10 items-center justify-center gap-3 border-t px-4 py-2 text-center text-xs font-medium ${problemCount ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]" : "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning-text)]"}`}>
    <span>{!online
      ? `You’re offline. Cached tasks are available${sync.pending ? `; ${sync.pending} change${sync.pending === 1 ? "" : "s"} will sync when you reconnect` : ""}.`
      : sync.syncing
        ? `Syncing ${sync.pending} offline change${sync.pending === 1 ? "" : "s"}…`
        : problemCount
          ? `${problemCount} offline change${problemCount === 1 ? "" : "s"} need attention${sync.conflicts ? ` (${sync.conflicts} conflict${sync.conflicts === 1 ? "" : "s"})` : ""}.`
          : `${sync.pending} change${sync.pending === 1 ? "" : "s"} waiting to sync.`}</span>
    {online && sync.pending > 0 && !sync.syncing && <button type="button" className="rounded-full border border-current px-2.5 py-1 font-semibold" onClick={() => void syncNow()}>Retry</button>}
    {online && problemCount > 0 && <button type="button" className="rounded-full border border-current px-2.5 py-1 font-semibold" onClick={() => void discardAndLoadServerVersions()}>Use server version</button>}
  </div>;
}
