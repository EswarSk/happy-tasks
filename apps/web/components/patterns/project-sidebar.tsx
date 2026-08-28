"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Boxes, ChevronDown, ChevronsLeft, ListTodo, Plus, Search, Settings2, Star, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { ThemeToggle } from "@/components/patterns/theme-toggle";
import type { Member, Project } from "@/lib/api";
import { dataSource, workspaceApi } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ProjectSidebar({ open, onClose, currentActor, collapsed = false, onToggleCollapse, onCreateTask }: { open: boolean; onClose: () => void; currentActor?: Member; collapsed?: boolean; onToggleCollapse: () => void; onCreateTask?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [globalSearchTerm, setGlobalSearchTerm] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => workspaceApi.listProjects() });
  const globalSearchQuery = useQuery({
    queryKey: ["global-task-search", globalSearchTerm, projectsQuery.data?.map((project) => project.id)],
    queryFn: async () => {
      const projects = projectsQuery.data ?? [];
      const pages = await Promise.all(projects.map(async (project) => {
        const page = await workspaceApi.listTasks(project.id, { search: globalSearchTerm, limit: 20 });
        return page.items.map((task) => ({ task, project }));
      }));
      return pages.flat();
    },
    enabled: searchOpen && globalSearchTerm.length > 1 && Boolean(projectsQuery.data?.length),
  });
  const currentProjectId = pathname.match(/\/projects\/([^/]+)/)?.[1];

  useEffect(() => {
    const timer = window.setTimeout(() => setGlobalSearchTerm(globalSearch.trim()), 240);
    return () => window.clearTimeout(timer);
  }, [globalSearch]);

  const createProject = useMutation({
    mutationFn: () => workspaceApi.createProject(name.trim(), description.trim()),
    onSuccess: (project) => {
      queryClient.setQueryData<Project[]>(["projects"], (current) => [project, ...(current ?? []).filter((item) => item.id !== project.id)]);
      setName("");
      setDescription("");
      setCreateOpen(false);
      onClose();
      toast.success("Project created");
      router.push(`/projects/${project.id}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Project could not be created"),
  });

  const openGlobalSearch = () => {
    setGlobalSearch("");
    setGlobalSearchTerm("");
    setSearchOpen(true);
  };
  const openWorkspaceSettings = () => setSettingsOpen(true);
  const openSearchResult = (projectId: string, taskId: string) => {
    setSearchOpen(false);
    setGlobalSearch("");
    onClose();
    router.push(`/projects/${projectId}/tasks/${taskId}`);
  };

  const renderContent = (isCollapsed: boolean) => (
    <aside className={cn("flex h-full flex-col overflow-hidden border border-[var(--border)] bg-[var(--sidebar)] shadow-sm shadow-[var(--shadow)] transition-[width] duration-200 lg:rounded-xl", isCollapsed ? "w-[80px]" : "w-[260px]")}>
      <div className={cn("flex h-[72px] items-center border-b border-[var(--border-subtle)]", isCollapsed ? "gap-1 px-1" : "gap-3 px-5")}>
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--brand)] text-[var(--primary-foreground)] shadow-sm"><Boxes className="size-[18px]" /></div>
        {!isCollapsed && <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight">Happy Tasks</div>
          <div className="text-xs text-[var(--text-muted)]">Collaborative workspace</div>
        </div>}
        <Button variant="ghost" size="icon" className={cn("ml-auto hidden shrink-0 rounded-md lg:inline-flex focus-visible:ring-[var(--border)]", isCollapsed && "size-7")} onClick={onToggleCollapse} aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}><ChevronsLeft className={cn("size-4 transition-transform", isCollapsed && "rotate-180")} /></Button>
      </div>

      <nav className={cn("flex-1 overflow-y-auto py-5", isCollapsed ? "px-2" : "px-3")} aria-label="Projects">
        <div className={cn("mb-3 flex items-center justify-between", isCollapsed ? "px-0" : "px-2")}>
          {!isCollapsed && <span className="text-[11px] font-semibold tracking-[.08em] text-[var(--text-muted)] uppercase">Projects</span>}
          <Button variant="ghost" size="icon" className="size-7" aria-label="Create project" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" /></Button>
        </div>
        <div className="space-y-1">
          {projectsQuery.isLoading && Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-[var(--skeleton)]" />)}
          {projectsQuery.data?.map((project) => {
            const active = pathname.includes(project.id);
            return (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                onClick={onClose}
                title={isCollapsed ? project.name : undefined}
                aria-current={active ? "page" : undefined}
                className={cn("group flex min-h-9 items-center rounded-md border border-transparent text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus)]", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3", active ? cn("text-[var(--text)]", !isCollapsed && "lg:border-[var(--border)] lg:bg-[var(--selected)]") : "text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]")}
              >
                <span className={cn("size-2.5 rounded-full", active ? "bg-[var(--text)]" : "bg-[var(--text-muted)]")} />
                {!isCollapsed && <span className="min-w-0 flex-1 truncate">{project.name}</span>}
                {!isCollapsed && active && <span className="rounded-full bg-[var(--panel)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">{project.taskCount >= 1000 ? `${Math.floor(project.taskCount / 1000)}k` : project.taskCount}</span>}
              </Link>
            );
          })}
        </div>
        <div className="my-5 border-t border-[var(--border)]" />
        {!isCollapsed && <div className="mb-2 px-2 text-[11px] font-semibold tracking-[.08em] text-[var(--text-muted)] uppercase">Workspace</div>}
        <button type="button" className={cn("flex min-h-9 w-full items-center rounded-md text-sm font-medium text-[var(--text-secondary)] outline-none hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3")} onClick={openGlobalSearch} title={isCollapsed ? "Search all tasks" : undefined} aria-label="Search all tasks"><Search className="size-4" />{!isCollapsed && "Search all tasks"}</button>
        {currentProjectId && <Link href={`/projects/${currentProjectId}/activity`} onClick={onClose} aria-current={pathname.endsWith("/activity") ? "page" : undefined} title={isCollapsed ? "Activity" : undefined} className={cn("mt-1 flex min-h-9 items-center rounded-md text-sm font-medium outline-none hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3", pathname.endsWith("/activity") ? "bg-[var(--selected)] text-[var(--text)]" : "text-[var(--text-secondary)]")}><Activity className="size-4" />{!isCollapsed && "Activity"}</Link>}
        <button type="button" className={cn("mt-1 flex min-h-9 w-full items-center rounded-md text-sm font-medium text-[var(--text-secondary)] outline-none hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3")} onClick={openWorkspaceSettings} title={isCollapsed ? "Workspace settings" : undefined} aria-label="Workspace settings"><Settings2 className="size-4" />{!isCollapsed && "Workspace settings"}</button>
        {!isCollapsed && <div className="mb-2 mt-5 px-2 text-[11px] font-semibold tracking-[.08em] text-[var(--text-muted)] uppercase">Views</div>}
        <button type="button" disabled title="All tasks view — coming soon" aria-label="All tasks view — coming soon" className={cn("flex min-h-9 w-full cursor-default items-center rounded-md text-sm font-medium text-[var(--text-muted)] opacity-70", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3")}><ListTodo className="size-4" />{!isCollapsed && <><span className="flex-1 text-left">All tasks</span><span className="text-[10px] font-medium uppercase tracking-wide">Soon</span></>}</button>
        <button type="button" disabled title="My tasks view — coming soon" aria-label="My tasks view — coming soon" className={cn("mt-1 flex min-h-9 w-full cursor-default items-center rounded-md text-sm font-medium text-[var(--text-muted)] opacity-70", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3")}><UserRound className="size-4" />{!isCollapsed && <><span className="flex-1 text-left">My tasks</span><span className="text-[10px] font-medium uppercase tracking-wide">Soon</span></>}</button>
        <button type="button" disabled title="Favorites view — coming soon" aria-label="Favorites view — coming soon" className={cn("mt-1 flex min-h-9 w-full cursor-default items-center rounded-md text-sm font-medium text-[var(--text-muted)] opacity-70", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3")}><Star className="size-4" />{!isCollapsed && <><span className="flex-1 text-left">Favorites</span><span className="text-[10px] font-medium uppercase tracking-wide">Soon</span></>}</button>
      </nav>

      <div className="border-t border-[var(--border)] p-3">
        <button type="button" className={cn("flex min-h-11 w-full items-center rounded-md text-left outline-none hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]", isCollapsed ? "justify-center px-0" : "gap-2.5 px-3")} title={isCollapsed ? currentActor?.displayName ?? "Demo user" : undefined}>
          <Avatar name={currentActor?.displayName ?? "Maya Chen"} color={currentActor?.color} />
          {!isCollapsed && <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{currentActor?.displayName ?? "Maya Chen"}</span><span className="block text-[11px] text-[var(--text-muted)]">Demo user</span></span>}
          {!isCollapsed && <ChevronDown className="size-3.5 text-[var(--text-muted)]" />}
        </button>
      </div>
    </aside>
  );

  return (
    <>
      <div className={cn("hidden h-dvh p-3 pr-0 transition-[width] duration-200 lg:block", collapsed ? "w-[92px]" : "w-[272px]")}>{renderContent(collapsed)}</div>
      {open && <div className="fixed inset-0 z-50 lg:hidden"><button className="absolute inset-0 bg-[var(--overlay)] backdrop-blur-[2px]" aria-label="Close project navigation" onClick={onClose} /> <div className="relative h-full w-[260px] animate-enter-up shadow-2xl">{renderContent(false)}</div></div>}
      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create a project" description="Projects keep tasks, dependencies, comments, and synchronization isolated.">
        <div className="space-y-4">
          <div><label className="text-xs font-semibold" htmlFor="project-name">Name</label><Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} className="mt-2" autoFocus placeholder="e.g. Reliability launch" /></div>
          <div><label className="text-xs font-semibold" htmlFor="project-description">Description</label><Textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} className="mt-2" rows={3} placeholder="What outcome is this project responsible for?" /></div>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button disabled={!name.trim() || createProject.isPending} onClick={() => createProject.mutate()}>{createProject.isPending ? "Creating…" : "Create project"}</Button></div>
        </div>
      </Dialog>
      <Dialog open={searchOpen} onOpenChange={(nextOpen) => { setSearchOpen(nextOpen); if (!nextOpen) setGlobalSearch(""); }} title="Quick find" description="Search tasks or choose a workspace action.">
        <Input value={globalSearch} onChange={(event) => setGlobalSearch(event.target.value)} autoFocus placeholder="Search tasks or commands…" aria-label="Search tasks or commands" />
        {!globalSearchTerm && <div className="mb-3 space-y-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1.5">
          {onCreateTask && <button type="button" onClick={() => { setSearchOpen(false); setGlobalSearch(""); onClose(); onCreateTask(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><Plus className="size-4 text-[var(--text-muted)]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-[var(--text)]">Create a task</span><span className="block text-xs text-[var(--text-muted)]">Add a task to the current project</span></span></button>}
          <button type="button" onClick={() => { setSearchOpen(false); setGlobalSearch(""); setCreateOpen(true); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><Plus className="size-4 text-[var(--text-muted)]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-[var(--text)]">Create a project</span><span className="block text-xs text-[var(--text-muted)]">Start a new project workspace</span></span></button>
          <button type="button" onClick={() => { setSearchOpen(false); setGlobalSearch(""); setSettingsOpen(true); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><Settings2 className="size-4 text-[var(--text-muted)]" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-[var(--text)]">Workspace settings</span><span className="block text-xs text-[var(--text-muted)]">Appearance and data source</span></span></button>
        </div>}
        <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1.5" aria-live="polite">
          {!globalSearchTerm && <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">Start typing to search tasks.</p>}
          {globalSearchTerm.length === 1 && <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">Type at least two characters.</p>}
          {globalSearchQuery.isFetching && <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">Searching…</p>}
          {globalSearchQuery.isError && <p className="px-3 py-8 text-center text-sm text-[var(--danger-text)]">Tasks could not be searched right now.</p>}
          {!globalSearchQuery.isFetching && !globalSearchQuery.isError && globalSearchTerm.length > 1 && globalSearchQuery.data?.length === 0 && <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">No matching tasks.</p>}
          {!globalSearchQuery.isFetching && globalSearchQuery.data?.map(({ task, project }) => (
            <button key={`${project.id}-${task.id}`} type="button" onClick={() => openSearchResult(project.id, task.id)} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-[var(--panel)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
              <span className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold text-[var(--text-muted)]">{task.key}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--text)]">{task.title}</span><span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">{project.name}</span></span>
            </button>
          ))}
        </div>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} title="Workspace settings" description="Manage the local workspace experience.">
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><div><p className="text-sm font-medium">Appearance</p><p className="mt-0.5 text-xs text-[var(--text-muted)]">Switch between the light and dark workspace themes.</p></div><ThemeToggle /></div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><p className="text-sm font-medium">Data source</p><p className="mt-0.5 text-xs text-[var(--text-muted)]">{dataSource === "mock" ? "Mock API with deterministic demo data" : "Go API backed by PostgreSQL"}</p></div>
          <Button variant="secondary" className="w-full" onClick={() => setSettingsOpen(false)}>Done</Button>
        </div>
      </Dialog>
    </>
  );
}
