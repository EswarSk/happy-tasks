"use client";

import { useEffect, useSyncExternalStore } from "react";

export function PwaRuntime() {
  const online = useSyncExternalStore(
    (onChange) => { window.addEventListener("online", onChange); window.addEventListener("offline", onChange); return () => { window.removeEventListener("online", onChange); window.removeEventListener("offline", onChange); }; },
    () => navigator.onLine,
    () => true,
  );

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
  }, []);

  if (online) return null;
  return <div className="fixed inset-x-0 bottom-0 z-[100] border-t border-[var(--warning-border)] bg-[var(--warning-bg)] px-4 py-2 text-center text-xs font-medium text-[var(--warning-text)]">You’re offline. The app shell is available; reconnect to save changes.</div>;
}
