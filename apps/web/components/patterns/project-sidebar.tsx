"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronDown, ChevronsLeft, Plus, Search, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import type { Project } from "@/lib/api";
import { workspaceApi } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ProjectSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => workspaceApi.listProjects() });
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

  const content = (
    <aside className="flex h-full w-[248px] flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
      <div className="flex h-16 items-center gap-3 border-b border-[var(--border)] px-4">
        <div className="grid size-8 place-items-center rounded-[10px] bg-[var(--brand)] text-white shadow-sm"><Boxes className="size-[18px]" /></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight">Happy Tasks</div>
          <div className="text-[11px] text-[var(--text-muted)]">Collaborative workspace</div>
        </div>
        <Button variant="ghost" size="icon" className="hidden lg:inline-flex" aria-label="Collapse sidebar"><ChevronsLeft className="size-4" /></Button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Projects">
        <div className="mb-3 flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold tracking-[.08em] text-[var(--text-muted)] uppercase">Projects</span>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Create project" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" /></Button>
        </div>
        <div className="space-y-1">
          {projectsQuery.isLoading && Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-slate-200/60" />)}
          {projectsQuery.data?.map((project) => {
            const active = pathname.includes(project.id);
            return (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                onClick={onClose}
                aria-current={active ? "page" : undefined}
                className={cn("group flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus)]", active ? "bg-indigo-50 text-indigo-900" : "text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]")}
              >
                <span className="size-2.5 rounded-[4px]" style={{ background: project.accent }} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {active && <span className="text-[10px] font-semibold text-indigo-500">{project.taskCount >= 1000 ? `${Math.floor(project.taskCount / 1000)}k` : project.taskCount}</span>}
              </Link>
            );
          })}
        </div>
        <div className="my-5 border-t border-[var(--border)]" />
        <button className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)]"><Search className="size-4" />Search all tasks</button>
        <button className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--hover)]"><Settings2 className="size-4" />Workspace settings</button>
      </nav>

      <div className="border-t border-[var(--border)] p-3">
        <button className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-[var(--hover)]">
          <Avatar name="Avery Chen" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">Avery Chen</span><span className="block text-[11px] text-[var(--text-muted)]">Demo user</span></span>
          <ChevronDown className="size-3.5 text-[var(--text-muted)]" />
        </button>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden h-dvh lg:block">{content}</div>
      {open && <div className="fixed inset-0 z-50 lg:hidden"><button className="absolute inset-0 bg-slate-950/30" aria-label="Close project navigation" onClick={onClose} /> <div className="relative h-full w-[248px] shadow-2xl">{content}</div></div>}
      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create a project" description="Projects keep tasks, dependencies, comments, and synchronization isolated.">
        <div className="space-y-4">
          <div><label className="text-xs font-semibold" htmlFor="project-name">Name</label><Input id="project-name" value={name} onChange={(event) => setName(event.target.value)} className="mt-2" autoFocus placeholder="e.g. Reliability launch" /></div>
          <div><label className="text-xs font-semibold" htmlFor="project-description">Description</label><Textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} className="mt-2" rows={3} placeholder="What outcome is this project responsible for?" /></div>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button><Button disabled={!name.trim() || createProject.isPending} onClick={() => createProject.mutate()}>{createProject.isPending ? "Creating…" : "Create project"}</Button></div>
        </div>
      </Dialog>
    </>
  );
}
