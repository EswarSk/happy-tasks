"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PriorityBadge, StatusIcon, TaskStatusSelect, statusLabels } from "@/components/patterns/task-badges";
import { patchTaskInCache } from "@/features/tasks/query-cache";
import type { Member, Task, TaskFilters, TaskStatus } from "@/lib/api";
import { WorkspaceApiError, workspaceApi } from "@/lib/api";
import { cn } from "@/lib/utils";

const statuses: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];

export function TaskBoard({ projectId, filters, members, selectedTaskId, onOpenTask }: { projectId: string; filters: TaskFilters; members: Member[]; selectedTaskId?: string; onOpenTask: (taskId: string) => void }) {
  const queryClient = useQueryClient();
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const query = useInfiniteQuery({
    queryKey: ["tasks", projectId, filters.search ?? "", filters.status ?? "all", filters.priority ?? "all", filters.assigneeId ?? "all", filters.tag ?? ""],
    initialPageParam: "",
    queryFn: ({ pageParam }) => workspaceApi.listTasks(projectId, { ...filters, cursor: pageParam || undefined, limit: 100 }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const tasks = query.data?.pages.flatMap((page) => page.items) ?? [];
  const updateStatus = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) => workspaceApi.updateTask(projectId, task.id, { status, expectedVersion: task.version }),
    onMutate: async ({ task, status }) => {
      await queryClient.cancelQueries({ queryKey: ["tasks", projectId] });
      patchTaskInCache(queryClient, projectId, { ...task, status, syncState: "pending" });
      return { task };
    },
    onError: (error, _variables, context) => {
      if (context?.task) patchTaskInCache(queryClient, projectId, context.task);
      if (error instanceof WorkspaceApiError && error.status === 409) toast.error("This task changed elsewhere. Reload it before moving it.");
      else toast.error(error instanceof Error ? error.message : "Task could not be moved");
    },
    onSuccess: (saved) => {
      patchTaskInCache(queryClient, projectId, { ...saved, syncState: "synced" });
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });

  if (query.isLoading) return <div className="grid h-full grid-cols-4 gap-3 p-4">{statuses.map((status) => <div key={status} className="h-64 animate-pulse rounded-2xl bg-[var(--skeleton)]" />)}</div>;
  if (query.isError) return <div className="grid h-full place-items-center p-8 text-center"><div><AlertCircle className="mx-auto mb-3 size-6 text-[var(--danger)]" /><h2 className="font-semibold">Board could not be loaded</h2><Button variant="secondary" className="mt-4" onClick={() => query.refetch()}><RefreshCw className="size-4" />Retry</Button></div></div>;

  return <div className="h-full overflow-auto" aria-label="Kanban board"><div className="grid min-w-[900px] grid-cols-4 gap-3 p-4 sm:p-5">
    {statuses.map((status) => {
      const column = tasks.filter((task) => task.status === status);
      return <section key={status} className="flex min-h-[360px] flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-2" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const task = tasks.find((item) => item.id === draggedTaskId); if (task && task.status !== status) updateStatus.mutate({ task, status }); setDraggedTaskId(undefined); }}>
        <header className="flex items-center justify-between px-2 py-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><StatusIcon status={status} />{statusLabels[status]}</h2><span className="rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">{column.length}</span></header>
        <div className="min-h-40 space-y-2 rounded-xl p-1">
          {column.map((task) => <article key={task.id} draggable onDragStart={() => setDraggedTaskId(task.id)} onDragEnd={() => setDraggedTaskId(undefined)} className={cn("rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 shadow-sm transition-shadow hover:shadow-md", draggedTaskId === task.id && "opacity-50")}>
            <button type="button" onClick={() => onOpenTask(task.id)} aria-label={`Open ${task.key}: ${task.title}`} className={cn("w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]", selectedTaskId === task.id && "rounded-md")}>{<span className="font-mono text-[10px] font-semibold text-[var(--text-muted)]">{task.key}</span>}<span className="mt-1 block text-sm font-medium leading-5">{task.title}</span></button>
            <div className="mt-3 flex items-center justify-between gap-2"><PriorityBadge priority={task.priority} /><span className="inline-flex items-center gap-1 text-[10px] text-[var(--text-muted)]"><Check className="size-3" />{task.commentCount}</span></div>
            <div className="mt-3" onClick={(event) => event.stopPropagation()}><TaskStatusSelect value={task.status} disabled={updateStatus.isPending} onChange={(next) => { if (next !== task.status) updateStatus.mutate({ task, status: next }); }} /></div>
            {task.assigneeIds.length > 0 && <p className="mt-2 truncate text-[10px] text-[var(--text-muted)]">{task.assigneeIds.map((id) => members.find((member) => member.id === id)?.displayName).filter(Boolean).join(", ")}</p>}
          </article>)}
          {!column.length && <div className="grid min-h-28 place-items-center rounded-xl border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--text-muted)]">Drop tasks here</div>}
        </div>
      </section>;
    })}
  </div>{query.hasNextPage && <div className="border-t border-[var(--border)] p-3 text-center"><Button variant="secondary" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : `Load more (${tasks.length.toLocaleString()} shown)`}</Button></div>}</div>;
}
