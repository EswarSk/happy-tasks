export default function OfflinePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--background)] px-5 text-center text-[var(--text)]">
      <div className="max-w-sm"><p className="text-xs font-semibold tracking-[.12em] text-[var(--text-muted)] uppercase">Happy Tasks</p><h1 className="mt-3 text-2xl font-semibold">You’re offline</h1><p className="mt-2 text-sm text-[var(--text-secondary)]">The installed app shell is still available. Reconnect to load the latest project data and save changes.</p></div>
    </main>
  );
}
