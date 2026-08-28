"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ArrowDownUp, Copy, Link2, MessageCircle, RefreshCw } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PriorityBadge, TaskStatusBadge } from "@/components/patterns/task-badges";
import type { Member, Task, TaskFilters } from "@/lib/api";
import { workspaceApi } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

interface TaskListProps {
  projectId: string;
  filters: TaskFilters;
  members: Member[];
  selectedTaskId?: string;
  onOpenTask: (taskId: string) => void;
}

const TaskRow = memo(function TaskRow({ task, members, selected, onOpen }: { task: Task; members: Member[]; selected: boolean; onOpen: () => void }) {
  const assignees = task.assigneeIds.map((id) => members.find((member) => member.id === id)).filter(Boolean) as Member[];
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${task.key}: ${task.title}`}
        className={cn(
          "task-grid grid h-14 w-full items-center border-b border-[var(--border-subtle)] px-4 pr-12 text-left outline-none transition-colors hover:bg-[var(--hover)] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)] sm:px-5 sm:pr-12",
          selected && "bg-[var(--selected)] hover:bg-[var(--selected)] shadow-[inset_3px_0_0_var(--brand)]",
        )}
      >
        <TaskStatusBadge status={task.status} />
        <div className="min-w-0 py-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[10px] font-semibold text-[var(--text-muted)]">{task.key}</span>
            <span className="truncate text-sm font-medium text-[var(--text)]">{task.title}</span>
          </div>
          <div className="task-grid-mobile-priority mt-1 flex gap-1.5"><PriorityBadge priority={task.priority} /><span className="text-xs text-[var(--text-muted)]">{relativeTime(task.updatedAt)}</span></div>
        </div>
        <div className="task-grid-priority"><PriorityBadge priority={task.priority} /></div>
        <div className="task-grid-assignee -space-x-1.5">
          {assignees.length ? assignees.slice(0, 3).map((member) => <Avatar key={member.id} name={member.displayName} color={member.color} className="size-6" />) : <span className="text-xs text-[var(--text-muted)]">Unassigned</span>}
        </div>
        <div className="task-grid-signals items-center gap-3 text-xs text-[var(--text-muted)]">
          {(task.dependencyIds.length > 0 || task.blockingCount > 0) && <span className="inline-flex items-center gap-1"><Link2 className="size-3.5" />{task.dependencyIds.length + task.blockingCount}</span>}
          <span className="inline-flex items-center gap-1"><MessageCircle className="size-3.5" />{task.commentCount}</span>
        </div>
        <span className="task-grid-updated text-right text-xs text-[var(--text-muted)]">{relativeTime(task.updatedAt)}</span>
      </button>
      <button type="button" aria-label={`Copy task key ${task.key}`} title="Copy task key" onClick={(event) => { event.stopPropagation(); void navigator.clipboard?.writeText(task.key); toast.success("Task key copied"); }} className="absolute top-1/2 right-3 z-10 hidden size-7 -translate-y-1/2 place-items-center rounded-md border border-[var(--border)] bg-[var(--panel)] text-[var(--text-muted)] shadow-sm hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:grid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] group-hover:grid"><Copy className="size-3.5" /></button>
    </div>
  );
});

export function TaskList({ projectId, filters, members, selectedTaskId, onOpenTask }: TaskListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const query = useInfiniteQuery({
    queryKey: ["tasks", projectId, filters.search ?? "", filters.status ?? "all", filters.priority ?? "all", filters.assigneeId ?? "all", filters.tag ?? ""],
    initialPageParam: "",
    queryFn: ({ pageParam }) => workspaceApi.listTasks(projectId, { ...filters, cursor: pageParam || undefined, limit: 100 }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const tasks = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const totalCount = query.data?.pages[0]?.totalCount ?? 0;
  const hasActiveFilters = Boolean(
    filters.search?.trim()
      || (filters.status && filters.status !== "all")
      || (filters.priority && filters.priority !== "all")
      || filters.assigneeId
      || filters.tag?.trim(),
  );
  // TanStack Virtual intentionally returns imperative functions tied to scroll state.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: query.hasNextPage ? tasks.length + 1 : tasks.length, getScrollElement: () => parentRef.current, estimateSize: () => 56, overscan: 8 });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index;

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  useEffect(() => {
    if (lastIndex !== undefined && lastIndex >= tasks.length - 8 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [lastIndex, tasks.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isLoading) {
    return <div className="space-y-1 p-3">{Array.from({ length: 10 }).map((_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-[var(--skeleton)]" />)}</div>;
  }

  if (query.isError) {
    return <div className="grid h-full place-items-center p-8 text-center"><div><AlertCircle className="mx-auto mb-3 size-6 text-[var(--danger)]" /><h2 className="font-semibold">Tasks could not be loaded</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">Check the data source and try again.</p><Button variant="secondary" className="mt-4" onClick={() => query.refetch()}><RefreshCw className="size-4" />Retry</Button></div></div>;
  }

  if (!tasks.length) {
    return <div className="grid h-full place-items-center p-8 text-center"><div><h2 className="font-semibold">{hasActiveFilters ? "No tasks match these filters" : "No tasks yet"}</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">{hasActiveFilters ? "Try a broader search or clear a filter." : "Create the first task to start planning this project."}</p></div></div>;
  }

  return (
    <div className="task-list-container flex h-full min-h-0 flex-col">
      <div className="task-grid hidden h-10 shrink-0 items-center border-b border-[var(--border)] bg-[var(--panel)] px-5 pr-12 text-[10px] font-semibold tracking-[.06em] text-[var(--text-muted)] uppercase md:grid">
        <span>Status</span><span>Task</span><span className="task-grid-priority">Priority</span><span className="task-grid-assignee">Assignee</span><span className="task-grid-signals">Signals</span><span className="task-grid-updated text-right">Updated</span>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto contain-strict" aria-label={`${totalCount.toLocaleString()} tasks`}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualRow) => {
            const task = tasks[virtualRow.index];
            if (!task) {
              return <div key="loader" className="absolute left-0 grid h-14 w-full place-items-center text-xs text-[var(--text-muted)]" style={{ transform: `translateY(${virtualRow.start}px)` }}><RefreshCw className="mr-2 inline size-3 animate-spin" />Loading more tasks…</div>;
            }
            return <div className="absolute top-0 left-0 w-full" key={task.id} style={{ transform: `translateY(${virtualRow.start}px)` }}><TaskRow task={task} members={members} selected={task.id === selectedTaskId} onOpen={() => onOpenTask(task.id)} /></div>;
          })}
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t border-[var(--border)] px-4 text-[11px] text-[var(--text-muted)]">
        <span>{tasks.length.toLocaleString()} loaded{totalCount > tasks.length ? ` of ${totalCount.toLocaleString()}` : hasNextPage ? " · more available" : ""}</span>
        <span className="inline-flex items-center gap-1"><ArrowDownUp className="size-3" />Updated recently</span>
      </div>
    </div>
  );
}
