"use client";

import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, List, Menu, Plus, Search, Sparkles, Tags, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConnectionStatus } from "@/components/patterns/connection-status";
import { ProjectSidebar } from "@/components/patterns/project-sidebar";
import { ThemeToggle } from "@/components/patterns/theme-toggle";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { prependTaskToCache } from "@/features/tasks/query-cache";
import { ActivityFeed } from "@/features/activity/activity-feed";
import { NotificationBell } from "@/features/notifications/notification-bell";
import { PresenceStrip } from "@/features/collaboration/presence-strip";
import { useProjectPresence } from "@/features/collaboration/use-project-presence";
import { TaskDetailPanel } from "@/features/tasks/task-detail-panel";
import { TaskList } from "@/features/tasks/task-list";
import { TaskBoard } from "@/features/tasks/task-board";
import { useProjectEvents } from "@/features/realtime/use-project-events";
import { dataSource, demoActorId, type ConnectionState, type Project, type TaskFilters, type TaskPriority, type TaskStatus, workspaceApi } from "@/lib/api";

interface WorkspaceShellProps { projectId: string; selectedTaskId?: string; showActivity?: boolean }

export function WorkspaceShell({ projectId, selectedTaskId, showActivity = false }: WorkspaceShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("happy-tasks.sidebar-collapsed") === "true");
  const [createOpen, setCreateOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [createProjectId, setCreateProjectId] = useState(projectId);
  const [connection, setConnection] = useState<ConnectionState>("live");
  const [expandedDetailTaskId, setExpandedDetailTaskId] = useState<string | null>(null);
  const detailPanelRef = usePanelRef();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const showDebugMetadata = process.env.NEXT_PUBLIC_DEBUG_UI === "true";
  const bootstrap = useQuery({ queryKey: ["bootstrap", projectId], queryFn: () => workspaceApi.bootstrap(projectId) });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => workspaceApi.listProjects() });
  const realtimeState = useProjectEvents(projectId, bootstrap.data?.streamCursor ?? 0, dataSource === "api" && Boolean(bootstrap.data));
  const presence = useProjectPresence(projectId, selectedTaskId, Boolean(bootstrap.data));
  const displayedConnection = dataSource === "api" ? realtimeState : connection;
  const status = (searchParams.get("status") ?? "all") as TaskStatus | "all";
  const priority = (searchParams.get("priority") ?? "all") as TaskPriority | "all";
  const assigneeId = searchParams.get("assignee") ?? "all";
  const tag = searchParams.get("tag") ?? "";
  const view = searchParams.get("view") === "board" ? "board" : "list";
  const filters: TaskFilters = { search: searchParams.get("q") ?? "", status, priority, assigneeId: assigneeId === "all" ? undefined : assigneeId, tag };

  useEffect(() => {
    window.localStorage.setItem("happy-tasks.sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (search.trim() === (searchParams.get("q") ?? "")) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (search.trim()) params.set("q", search.trim()); else params.delete("q");
      const base = selectedTaskId ? `/projects/${projectId}/tasks/${selectedTaskId}` : `/projects/${projectId}`;
      router.replace(`${base}${params.size ? `?${params}` : ""}`, { scroll: false });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [search, projectId, selectedTaskId, router, searchParams]);

  const setFilter = (name: "status" | "priority" | "assignee" | "tag", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete(name); else params.set(name, value);
    const base = selectedTaskId ? `/projects/${projectId}/tasks/${selectedTaskId}` : `/projects/${projectId}`;
    router.replace(`${base}${params.size ? `?${params}` : ""}`, { scroll: false });
  };
  const setView = (nextView: "list" | "board") => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextView === "list") params.delete("view"); else params.set("view", nextView);
    const base = selectedTaskId ? `/projects/${projectId}/tasks/${selectedTaskId}` : `/projects/${projectId}`;
    router.replace(`${base}${params.size ? `?${params}` : ""}`, { scroll: false });
  };
  const openTaskInProject = (targetProjectId: string, taskId: string) => {
    // Preserve filters when opening within the current project, but avoid
    // carrying a stale search/status filter into a different project.
    const params = targetProjectId === projectId ? searchParams.toString() : "";
    router.push(`/projects/${targetProjectId}/tasks/${taskId}${params ? `?${params}` : ""}`, { scroll: false });
  };
  const openTask = (taskId: string) => {
    openTaskInProject(projectId, taskId);
  };
  const openCreateTask = () => {
    setCreateProjectId(projectId);
    setNewTaskTitle("");
    setCreateOpen(true);
  };
  const closeTask = () => {
    const params = searchParams.toString();
    router.push(`/projects/${projectId}${params ? `?${params}` : ""}`, { scroll: false });
  };
  const toggleDetailPanel = () => {
    if (!selectedTaskId) return;
    const detailExpanded = expandedDetailTaskId === selectedTaskId;
    const nextExpanded = !detailExpanded;
    detailPanelRef.current?.resize(nextExpanded ? "62%" : "42%");
    setExpandedDetailTaskId(nextExpanded ? selectedTaskId : null);
  };

  const createTask = useMutation({
    mutationFn: () => workspaceApi.createTask(createProjectId, newTaskTitle.trim()),
    onSuccess: (task) => {
      prependTaskToCache(queryClient, task.projectId, task);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setCreateOpen(false);
      setNewTaskTitle("");
      toast.success("Task created");
      openTaskInProject(task.projectId, task.id);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Task could not be created"),
  });

  if (bootstrap.isLoading) {
    return <div className="flex h-dvh gap-3 bg-[var(--background)] p-3"><div className="hidden w-[260px] animate-pulse rounded-xl border border-[var(--border)] bg-[var(--skeleton)] lg:block" /><main className="flex-1"><div className="h-[110px] animate-pulse rounded-xl bg-[var(--skeleton)]" /><div className="mt-3 h-[calc(100%-122px)] animate-pulse rounded-xl bg-[var(--skeleton)]" /></main></div>;
  }
  if (!bootstrap.data) {
    return <div className="grid h-dvh place-items-center bg-[var(--background)]"><div className="text-center"><h1 className="font-semibold">Project unavailable</h1><p className="mt-1 text-sm text-[var(--text-secondary)]">The workspace could not be bootstrapped.</p><Button variant="secondary" className="mt-4" onClick={() => bootstrap.refetch()}>Try again</Button></div></div>;
  }

  const { project, members } = bootstrap.data;
  const availableProjects: Project[] = [project, ...(projectsQuery.data ?? []).filter((item) => item.id !== project.id)];
  const selectedCreateProject = availableProjects.find((item) => item.id === createProjectId) ?? project;
  const currentActor = members.find((member) => member.id === demoActorId) ?? members.find((member) => member.role === "OWNER") ?? members[0];
  const taskList = view === "board" ? <TaskBoard projectId={projectId} filters={filters} members={members} selectedTaskId={selectedTaskId} onOpenTask={openTask} /> : <TaskList projectId={projectId} filters={filters} members={members} selectedTaskId={selectedTaskId} onOpenTask={openTask} />;
  const detailExpanded = Boolean(selectedTaskId && expandedDetailTaskId === selectedTaskId);
  const taskDetail = selectedTaskId ? <TaskDetailPanel projectId={projectId} taskId={selectedTaskId} members={members} collaborators={presence.collaborators} onSelectionChange={presence.updateSelection} onClose={closeTask} onOpenTask={openTask} onToggleExpand={toggleDetailPanel} detailExpanded={detailExpanded} /> : null;

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--background)] text-[var(--text)]">
      <ProjectSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} currentActor={currentActor} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((current) => !current)} onCreateTask={openCreateTask} />
      <main className="flex min-w-0 flex-1 flex-col gap-0 lg:gap-3 lg:p-3">
        <header className="shrink-0 border-b border-[var(--border)] bg-[var(--panel)] shadow-sm shadow-[var(--shadow)] lg:rounded-xl lg:border">
          <div className="flex min-h-[64px] items-center gap-3 px-4 lg:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open project navigation"><Menu className="size-5" /></Button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><h1 className="truncate text-base font-semibold tracking-tight">{project.name}</h1><ConnectionStatus state={displayedConnection} /></div>
              <p className="hidden truncate text-xs text-[var(--text-muted)] sm:block">{project.description}</p>
            </div>
            <div className="hidden items-center gap-2 xl:flex">
              {showDebugMetadata && <span className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 font-mono text-[10px] font-semibold text-[var(--text-muted)]">{dataSource === "mock" ? "MOCK API" : "GO API"}</span>}
              {dataSource === "mock" && <Select label="Demo connection state" value={connection} onValueChange={(value) => setConnection(value as ConnectionState)} options={[{ value: "live", label: "Live" }, { value: "reconnecting", label: "Reconnecting" }, { value: "offline", label: "Offline" }]} className="min-w-32" />}
            </div>
            <PresenceStrip collaborators={presence.collaborators} members={members} />
            <NotificationBell projectId={projectId} members={members} />
            <ThemeToggle />
            <Button onClick={openCreateTask} aria-label="Create new task" title="Create new task"><Plus className="size-4" /><span className="hidden sm:inline">New task</span></Button>
          </div>
          {!showActivity && <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-2.5 lg:px-6">
            <div className="relative min-w-[200px] flex-[1_1_240px] sm:max-w-sm"><Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[var(--text-muted)]" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks…" className="pl-10" /></div>
            <div className="flex items-center rounded-full border border-[var(--border)] bg-[var(--panel)] p-0.5" role="group" aria-label="Task view"><Button type="button" variant={view === "list" ? "primary" : "ghost"} size="sm" className="min-h-8 px-3" onClick={() => setView("list")} aria-pressed={view === "list"}><List className="size-3.5" /><span className="hidden sm:inline">List</span></Button><Button type="button" variant={view === "board" ? "primary" : "ghost"} size="sm" className="min-h-8 px-3" onClick={() => setView("board")} aria-pressed={view === "board"}><LayoutGrid className="size-3.5" /><span className="hidden sm:inline">Board</span></Button></div>
            <Select label="Filter by status" value={status} onValueChange={(value) => setFilter("status", value)} options={[{ value: "all", label: "All statuses" }, { value: "todo", label: "To do" }, { value: "in_progress", label: "In progress" }, { value: "blocked", label: "Blocked" }, { value: "done", label: "Done" }]} />
            <Select label="Filter by priority" value={priority} onValueChange={(value) => setFilter("priority", value)} options={[{ value: "all", label: "All priorities" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }]} />
            <Select label="Filter by assignee" value={assigneeId} onValueChange={(value) => setFilter("assignee", value)} options={[{ value: "all", label: "All assignees" }, ...members.filter((member) => member.membershipStatus === "ACTIVE" || !member.membershipStatus).map((member) => ({ value: member.id, label: member.displayName }))]} />
            <div className="relative min-w-36"><Tags className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" /><Input aria-label="Filter by tag" value={tag} onChange={(event) => setFilter("tag", event.target.value)} placeholder="Filter tags…" className="pl-9" /></div>
          </div>}
        </header>
        <div className="min-h-0 flex-1 overflow-hidden bg-[var(--panel)] lg:rounded-xl lg:border lg:border-[var(--border)] lg:shadow-sm lg:shadow-[var(--shadow)]">
          {showActivity ? <ActivityFeed projectId={projectId} members={members} /> : <>
            <div className="hidden h-full lg:block">
              <Group orientation="horizontal">
                <Panel id="tasks" minSize="38%" defaultSize={selectedTaskId ? "58%" : "100%"}>{taskList}</Panel>
                {selectedTaskId && <><Separator className="group relative w-px bg-[var(--border)] outline-none after:absolute after:inset-y-0 after:-left-1 after:w-3 hover:bg-[var(--brand)] focus-visible:bg-[var(--brand)]" /><Panel id="detail" panelRef={detailPanelRef} minSize="34%" defaultSize="42%" onResize={(size) => setExpandedDetailTaskId(size.asPercentage >= 55 ? selectedTaskId : null)}>{taskDetail}</Panel></>}
              </Group>
            </div>
            <div className="h-full lg:hidden">{taskList}</div>
            {selectedTaskId && <div className="fixed inset-0 z-40 bg-[var(--panel)] lg:hidden">{taskDetail}</div>}
          </>}
        </div>
      </main>
      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create a task" description="Choose the project first, then give the task a clear outcome.">
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold" htmlFor="new-task-project">Project</label>
            <Select
              id="new-task-project"
              label="Project"
              value={selectedCreateProject.id}
              disabled={createTask.isPending}
              onValueChange={setCreateProjectId}
              options={availableProjects.map((item) => ({ value: item.id, label: item.name }))}
              className="mt-2 w-full"
            />
            <p className="mt-2 text-xs text-[var(--text-muted)]">This task will be created in <span className="font-medium text-[var(--text-secondary)]">{selectedCreateProject.name}</span>.</p>
          </div>
          <div>
            <label className="text-xs font-semibold" htmlFor="new-task-title">Task title</label>
            <Input id="new-task-title" value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTaskTitle.trim() && !createTask.isPending) createTask.mutate(); }} className="mt-2" autoFocus placeholder="e.g. Verify reconnect replay under load" />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4"><span className="hidden items-center gap-1 text-[11px] text-[var(--text-muted)] sm:inline-flex"><Sparkles className="size-3" />Optimistic, project-scoped create</span><div className="ml-auto flex gap-2"><Button variant="secondary" onClick={() => setCreateOpen(false)}><X className="size-3.5" />Cancel</Button><Button onClick={() => createTask.mutate()} disabled={!newTaskTitle.trim() || createTask.isPending}>{createTask.isPending ? "Creating…" : "Create task"}</Button></div></div>
        </div>
      </Dialog>
    </div>
  );
}
