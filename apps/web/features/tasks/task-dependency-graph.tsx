"use client";

import { ArrowRight, GitBranch, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PriorityBadge, StatusIcon, statusLabels } from "@/components/patterns/task-badges";
import type { Task } from "@/lib/api";
import { cn } from "@/lib/utils";

interface TaskDependencyGraphProps {
  task: Task;
  relatedTasks: Task[];
  isLoading?: boolean;
  onOpenTask: (taskId: string) => void;
}

export interface TaskConnections {
  dependencies: Array<Task | string>;
  blockers: Task[];
  hiddenBlockers: number;
}

export function getTaskConnections(task: Task, relatedTasks: Task[]): TaskConnections {
  const tasksById = new Map(relatedTasks.map((item) => [item.id, item]));
  const dependencies = task.dependencyIds.map((id) => tasksById.get(id) ?? id);
  const blockers = relatedTasks.filter((item) => item.id !== task.id && item.dependencyIds.includes(task.id));

  return {
    dependencies,
    blockers,
    hiddenBlockers: Math.max(task.blockingCount - blockers.length, 0),
  };
}

function TaskNode({ task, onOpenTask }: { task: Task | string; onOpenTask: (taskId: string) => void }) {
  const isLoaded = typeof task !== "string";
  const id = isLoaded ? task.id : task;
  const key = isLoaded ? task.key : `Task ${task.slice(0, 8)}`;
  const title = isLoaded ? task.title : "Task details unavailable";

  return (
    <button
      type="button"
      onClick={() => onOpenTask(id)}
      aria-label={`Open ${key}: ${title}`}
      className={cn(
        "group w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-left shadow-sm outline-none transition hover:-translate-y-0.5 hover:border-[var(--text-muted)] hover:shadow-md focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        !isLoaded && "border-dashed bg-[var(--surface-muted)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold tracking-wide text-[var(--text-muted)]">{key}</span>
        <ArrowRight className="size-3.5 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" />
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs font-semibold leading-5 text-[var(--text)]">{title}</p>
      {isLoaded ? (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1"><StatusIcon status={task.status} />{statusLabels[task.status]}</span>
          <PriorityBadge priority={task.priority} />
        </div>
      ) : (
        <span className="mt-2 block text-[10px] text-[var(--text-muted)]">Open to load details</span>
      )}
    </button>
  );
}

function TaskColumn({
  label,
  tasks,
  totalCount = tasks.length,
  emptyLabel,
  onOpenTask,
}: {
  label: string;
  tasks: Array<Task | string>;
  totalCount?: number;
  emptyLabel: string;
  onOpenTask: (taskId: string) => void;
}) {
  const visibleTasks = tasks.slice(0, 4);
  const hiddenCount = Math.max(totalCount - visibleTasks.length, 0);

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="section-label">{label}</span>
        <span className="font-mono text-[10px] text-[var(--text-muted)]">{totalCount}</span>
      </div>
      <div className="mt-2 space-y-2">
        {visibleTasks.length ? visibleTasks.map((item) => <TaskNode key={typeof item === "string" ? item : item.id} task={item} onOpenTask={onOpenTask} />) : totalCount ? <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-[11px] leading-4 text-[var(--text-muted)]"><strong className="block text-sm text-[var(--text-secondary)]">{totalCount} linked {totalCount === 1 ? "task" : "tasks"}</strong>Not in this task window</div> : <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-5 text-center text-[11px] leading-4 text-[var(--text-muted)]">{emptyLabel}</div>}
        {hiddenCount > 0 && visibleTasks.length > 0 && <div className="flex items-center justify-center gap-1 pt-1 text-[10px] font-semibold text-[var(--text-muted)]"><MoreHorizontal className="size-3.5" />{hiddenCount} more</div>}
      </div>
    </div>
  );
}

export function TaskDependencyGraph({ task, relatedTasks, isLoading = false, onOpenTask }: TaskDependencyGraphProps) {
  const { dependencies, blockers } = getTaskConnections(task, relatedTasks);

  return (
    <section aria-labelledby="dependency-map-heading" className="border-b border-[var(--border-subtle)] pb-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2"><GitBranch className="size-4 text-[var(--brand)]" /><h2 id="dependency-map-heading" className="section-label text-[var(--text)]">Dependency map</h2></div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">See what this task needs and what it unlocks.</p>
        </div>
        <Badge className="shrink-0 border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]">{task.dependencyIds.length + task.blockingCount} links</Badge>
      </div>

      <div className="@container mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
        <div className="dependency-map-grid grid items-center gap-2">
          <TaskColumn label="Depends on" tasks={dependencies} totalCount={task.dependencyIds.length} emptyLabel="Nothing upstream" onOpenTask={onOpenTask} />
          <div className="dependency-map-connector flex items-center justify-center" aria-hidden="true"><div className="dependency-map-connector-line bg-[var(--border)]" /><ArrowRight className="size-4 shrink-0 text-[var(--text-muted)]" /></div>
          <div className="rounded-2xl border-2 border-[var(--brand)] bg-[var(--panel)] p-4 shadow-lg shadow-[var(--shadow)]">
            <div className="flex items-center justify-between gap-2"><span className="text-[10px] font-bold tracking-[.08em] text-[var(--brand)] uppercase">Current task</span><span className="size-2 rounded-full bg-[var(--brand)] shadow-[0_0_0_4px_var(--focus-soft)]" /></div>
            <p className="mt-2 line-clamp-3 text-sm font-semibold leading-5 text-[var(--text)]">{task.title}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2"><span className="font-mono text-[10px] font-semibold text-[var(--text-muted)]">{task.key}</span><Badge className="border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)]">{statusLabels[task.status]}</Badge><PriorityBadge priority={task.priority} /></div>
            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--border-subtle)] pt-3 text-[10px] text-[var(--text-muted)]"><span><strong className="block text-sm text-[var(--text)]">{task.dependencyIds.length}</strong>upstream</span><span><strong className="block text-sm text-[var(--text)]">{task.blockingCount}</strong>downstream</span></div>
          </div>
          <div className="dependency-map-connector flex items-center justify-center" aria-hidden="true"><ArrowRight className="size-4 shrink-0 text-[var(--text-muted)]" /><div className="dependency-map-connector-line bg-[var(--border)]" /></div>
          {isLoading ? <div className="space-y-2"><div className="h-[86px] animate-pulse rounded-xl bg-[var(--skeleton)]" /><div className="h-[86px] animate-pulse rounded-xl bg-[var(--skeleton)]" /></div> : <TaskColumn label="Blocks" tasks={blockers} totalCount={task.blockingCount} emptyLabel="Nothing waiting on this" onOpenTask={onOpenTask} />}
        </div>
      </div>
    </section>
  );
}
