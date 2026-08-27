"use client";

import { Circle, CircleCheck, CircleDashed, CircleStop, SignalHigh, SignalLow, SignalMedium } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import type { TaskPriority, TaskStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

export const statusLabels: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export const priorityLabels: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const statusStyles: Record<TaskStatus, string> = {
  todo: "border-slate-200 bg-slate-50 text-slate-600",
  in_progress: "border-indigo-200 bg-indigo-50 text-indigo-700",
  blocked: "border-rose-200 bg-rose-50 text-rose-700",
  done: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const Icon = status === "done" ? CircleCheck : status === "blocked" ? CircleStop : status === "in_progress" ? CircleDashed : Circle;
  return <Icon className={cn("size-3.5", className)} />;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge className={statusStyles[status]}><StatusIcon status={status} />{statusLabels[status]}</Badge>;
}

const priorityStyles: Record<TaskPriority, string> = {
  low: "border-slate-200 bg-white text-slate-500",
  medium: "border-sky-200 bg-sky-50 text-sky-700",
  high: "border-amber-200 bg-amber-50 text-amber-700",
  urgent: "border-rose-200 bg-rose-50 text-rose-700",
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const Icon = priority === "low" ? SignalLow : priority === "medium" ? SignalMedium : SignalHigh;
  return <Badge className={priorityStyles[priority]}><Icon className="size-3.5" />{priorityLabels[priority]}</Badge>;
}

export function TaskStatusSelect({ value, onChange, disabled }: { value: TaskStatus; onChange: (status: TaskStatus) => void; disabled?: boolean }) {
  return (
    <Select
      label="Task status"
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as TaskStatus)}
      options={Object.entries(statusLabels).map(([option, label]) => ({ value: option, label }))}
    />
  );
}

export function PrioritySelect({ value, onChange, disabled }: { value: TaskPriority; onChange: (priority: TaskPriority) => void; disabled?: boolean }) {
  return (
    <Select
      label="Task priority"
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as TaskPriority)}
      options={Object.entries(priorityLabels).map(([option, label]) => ({ value: option, label }))}
    />
  );
}
