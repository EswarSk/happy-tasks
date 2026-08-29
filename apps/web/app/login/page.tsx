"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dataSource, demoProjectId, workspaceApi } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [registering, setRegistering] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    setError("");
    try {
      if (registering) await workspaceApi.register(displayName, email, password);
      else await workspaceApi.login(email, password);
      if (dataSource === "mock") router.replace(`/projects/${demoProjectId}`);
      else {
        const projects = await workspaceApi.listProjects();
        router.replace(projects[0] ? `/projects/${projects[0].id}` : "/");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in could not be completed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--background)] px-5 py-10 text-[var(--text)]">
      <section className="w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--panel)] p-7 shadow-xl shadow-[var(--shadow)]">
        <div className="mb-8"><p className="text-xs font-semibold tracking-[.12em] text-[var(--text-muted)] uppercase">Happy Tasks</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">{registering ? "Create your workspace account" : "Welcome back"}</h1><p className="mt-2 text-sm text-[var(--text-secondary)]">Sign in to access your projects, files, and collaboration history.</p></div>
        <div className="space-y-4">
          {registering && <div><label className="text-xs font-semibold" htmlFor="display-name">Name</label><Input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2" autoComplete="name" /></div>}
          <div><label className="text-xs font-semibold" htmlFor="email">Email</label><Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2" autoComplete="email" /></div>
          <div><label className="text-xs font-semibold" htmlFor="password">Password</label><Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} className="mt-2" autoComplete={registering ? "new-password" : "current-password"} /></div>
          {error && <p className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger-text)]" role="alert">{error}</p>}
          <Button className="w-full" disabled={pending || !email || !password || registering && !displayName} onClick={() => void submit()}>{pending ? "Working…" : registering ? "Create account" : "Sign in"}</Button>
        </div>
        <button type="button" className="mt-5 w-full text-center text-sm text-[var(--text-secondary)] underline-offset-4 hover:text-[var(--text)] hover:underline" onClick={() => { setRegistering((value) => !value); setError(""); }}>{registering ? "Already have an account? Sign in" : "Need an account? Create one"}</button>
      </section>
    </main>
  );
}
