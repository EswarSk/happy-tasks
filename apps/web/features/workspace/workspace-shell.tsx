"use client";

import { Group, Panel, Separator } from "react-resizable-panels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter, Menu, Plus, Search, Sparkles, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConnectionStatus } from "@/components/patterns/connection-status";
import { ProjectSidebar } from "@/components/patterns/project-sidebar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { prependTaskToCache } from "@/features/tasks/query-cache";
import { TaskDetailPanel } from "@/features/tasks/task-detail-panel";
import { TaskList } from "@/features/tasks/task-list";
import { useProjectEvents } from "@/features/realtime/use-project-events";
import { dataSource, type ConnectionState, type TaskFilters, type TaskPriority, type TaskStatus, workspaceApi } from "@/lib/api";

interface WorkspaceShellProps { projectId: string; selectedTaskId?: string }

export function WorkspaceShell({ projectId, selectedTaskId }: WorkspaceShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("live");
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const bootstrap = useQuery({ queryKey: ["bootstrap", projectId], queryFn: () => workspaceApi.bootstrap(projectId) });
  const realtimeState = useProjectEvents(projectId, bootstrap.data?.streamCursor ?? 0, dataSource === "api" && Boolean(bootstrap.data));
  const displayedConnection = dataSource === "api" ? realtimeState : connection;
  const status = (searchParams.get("status") ?? "all") as TaskStatus | "all";
  const priority = (searchParams.get("priority") ?? "all") as TaskPriority | "all";
  const filters: TaskFilters = { search: searchParams.get("q") ?? "", status, priority };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (search.trim()) params.set("q", search.trim()); else params.delete("q");
      const base = selectedTaskId ? `/projects/${projectId}/tasks/${selectedTaskId}` : `/projects/${projectId}`;
      router.replace(`${base}${params.size ? `?${params}` : ""}`, { scroll: false });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [search, projectId, selectedTaskId, router, searchParams]);

  const setFilter = (name: "status" | "priority", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete(name); else params.set(name, value);
    const base = selectedTaskId ? `/projects/${projectId}/tasks/${selectedTaskId}` : `/projects/${projectId}`;
    router.replace(`${base}${params.size ? `?${params}` : ""}`, { scroll: false });
  };
  const openTask = (taskId: string) => {
    const params = searchParams.toString();
    router.push(`/projects/${projectId}/tasks/${taskId}${params ? `?${params}` : ""}`, { scroll: false });
  };
  const closeTask = () => {
    const params = searchParams.toString();
    router.push(`/projects/${projectId}${params ? `?${params}` : ""}`, { scroll: false });
  };

  const createTask = useMutation({
    mutationFn: () => workspaceApi.createTask(projectId, newTaskTitle.trim()),
    onSuccess: (task) => {
      prependTaskToCache(queryClient, projectId, task);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setCreateOpen(false);
      setNewTaskTitle("");
      toast.success("Task created");
      openTask(task.id);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Task could not be created"),
  });

  if (bootstrap.isLoading) {
    return <div className="flex h-dvh bg-[var(--background)]"><div className="hidden w-[248px] animate-pulse border-r border-[var(--border)] bg-slate-100 lg:block" /><main className="flex-1 p-6"><div className="h-10 w-64 animate-pulse rounded-lg bg-slate-100" /><div className="mt-8 h-[calc(100%-5rem)] animate-pulse rounded-xl bg-slate-100" /></main></div>;
  }
  if (!bootstrap.data) {
    return <div className="grid h-dvh place-items-center bg-[var(--background)]"><div className="text-center"><h1 className="font-semibold">Project unavailable</h1><p className="mt-1 text-sm text-[var(--text-secondary)]">The workspace could not be bootstrapped.</p><Button variant="secondary" className="mt-4" onClick={() => bootstrap.refetch()}>Try again</Button></div></div>;
  }

  const { project, members } = bootstrap.data;
  const taskList = <TaskList projectId={projectId} filters={filters} members={members} selectedTaskId={selectedTaskId} onOpenTask={openTask} />;
  const taskDetail = selectedTaskId ? <TaskDetailPanel projectId={projectId} taskId={selectedTaskId} members={members} onClose={closeTask} onOpenTask={openTask} /> : null;

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--background)] text-[var(--text)]">
      <ProjectSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--border)] bg-[var(--panel)]">
          <div className="flex min-h-16 items-center gap-3 px-4 lg:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open project navigation"><Menu className="size-5" /></Button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><h1 className="truncate text-[15px] font-semibold tracking-tight">{project.name}</h1><ConnectionStatus state={displayedConnection} /></div>
              <p className="hidden truncate text-xs text-[var(--text-muted)] sm:block">{project.description}</p>
            </div>
            <div className="hidden items-center gap-2 xl:flex">
              <span className="rounded-md bg-slate-100 px-2 py-1 font-mono text-[10px] font-semibold text-slate-500">{dataSource === "mock" ? "MOCK API" : "GO API"}</span>
              {dataSource === "mock" && <Select label="Demo connection state" value={connection} onValueChange={(value) => setConnection(value as ConnectionState)} options={[{ value: "live", label: "Live" }, { value: "reconnecting", label: "Reconnecting" }, { value: "offline", label: "Offline" }]} className="min-w-32" />}
            </div>
            <Button onClick={() => setCreateOpen(true)}><Plus className="size-4" /><span className="hidden sm:inline">New task</span></Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-2.5 lg:px-6">
            <div className="relative min-w-[220px] flex-1 sm:max-w-sm"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks…" className="pl-9" /></div>
            <Select label="Filter by status" value={status} onValueChange={(value) => setFilter("status", value)} options={[{ value: "all", label: "All statuses" }, { value: "todo", label: "To do" }, { value: "in_progress", label: "In progress" }, { value: "blocked", label: "Blocked" }, { value: "done", label: "Done" }]} />
            <Select label="Filter by priority" value={priority} onValueChange={(value) => setFilter("priority", value)} options={[{ value: "all", label: "All priorities" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }]} className="hidden sm:flex" />
            <Button variant="ghost" size="icon" className="sm:hidden" aria-label="More filters"><Filter className="size-4" /></Button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <div className="hidden h-full lg:block">
            <Group orientation="horizontal">
              <Panel id="tasks" minSize="38%" defaultSize={selectedTaskId ? "58%" : "100%"}>{taskList}</Panel>
              {selectedTaskId && <><Separator className="group relative w-px bg-[var(--border)] outline-none after:absolute after:inset-y-0 after:-left-1 after:w-3 hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)]" /><Panel id="detail" minSize="34%" defaultSize="42%">{taskDetail}</Panel></>}
            </Group>
          </div>
          <div className="h-full lg:hidden">{taskList}</div>
          {selectedTaskId && <div className="fixed inset-0 z-40 bg-[var(--panel)] lg:hidden">{taskDetail}</div>}
        </div>
      </main>
      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create a task" description="Start with a clear outcome. You can add details, ownership, and dependencies next.">
        <label className="text-xs font-semibold" htmlFor="new-task-title">Task title</label>
        <Input id="new-task-title" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTaskTitle.trim()) createTask.mutate(); }} className="mt-2" autoFocus placeholder="e.g. Verify reconnect replay under load" />
        <div className="mt-5 flex items-center justify-between gap-3"><span className="hidden items-center gap-1 text-[11px] text-[var(--text-muted)] sm:inline-flex"><Sparkles className="size-3" />Optimistic, project-scoped create</span><div className="ml-auto flex gap-2"><Button variant="secondary" onClick={() => setCreateOpen(false)}><X className="size-3.5" />Cancel</Button><Button onClick={() => createTask.mutate()} disabled={!newTaskTitle.trim() || createTask.isPending}>{createTask.isPending ? "Creating…" : "Create task"}</Button></div></div>
      </Dialog>
    </div>
  );
}
