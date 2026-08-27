"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Check, ChevronRight, Copy, Link2, MessageSquare, MoreHorizontal, Save, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { OptimisticStateIndicator } from "@/components/patterns/optimistic-state";
import { PrioritySelect, TaskStatusSelect } from "@/components/patterns/task-badges";
import { CommentThread } from "@/features/comments/comment-thread";
import { AssigneePicker } from "./assignee-picker";
import { AssignmentHistory } from "./assignment-history";
import { patchTaskInCache, removeTaskFromCache } from "./query-cache";
import type { Member, Task, UpdateTaskInput } from "@/lib/api";
import { WorkspaceApiError, workspaceApi } from "@/lib/api";

interface TaskDetailPanelProps {
  projectId: string;
  taskId: string;
  members: Member[];
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

export function TaskDetailPanel({ projectId, taskId, members, onClose, onOpenTask }: TaskDetailPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ taskId: "", description: "", title: "" });
  const [conflictOpen, setConflictOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dependencyError, setDependencyError] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const taskKey = ["task", projectId, taskId];
  const query = useQuery({ queryKey: taskKey, queryFn: () => workspaceApi.getTask(projectId, taskId) });
  const task = query.data;

  const update = useMutation({
    mutationFn: (input: UpdateTaskInput) => workspaceApi.updateTask(projectId, taskId, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: taskKey });
      const previous = queryClient.getQueryData<Task>(taskKey);
      if (previous) patchTaskInCache(queryClient, projectId, { ...previous, ...input, syncState: "pending" });
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) patchTaskInCache(queryClient, projectId, { ...context.previous, syncState: error instanceof WorkspaceApiError && error.status === 409 ? "conflict" : "failed" });
      if (error instanceof WorkspaceApiError && error.status === 409) setConflictOpen(true);
      else toast.error(error instanceof Error ? error.message : "Task could not be saved");
    },
    onSuccess: (saved, input) => {
      patchTaskInCache(queryClient, projectId, { ...saved, syncState: "synced" });
      setDraft({ taskId: saved.id, title: saved.title, description: saved.description });
      if (input.assigneeIds) void queryClient.invalidateQueries({ queryKey: ["assignment-history", projectId, taskId] });
    },
  });

  const candidateQuery = useQuery({
    queryKey: ["dependency-candidates", projectId, taskId],
    queryFn: () => workspaceApi.listTasks(projectId, { limit: 20 }),
    enabled: Boolean(task),
  });

  const dependencyMutation = useMutation({
    mutationFn: (dependencyTaskId: string) => workspaceApi.addDependency(projectId, taskId, dependencyTaskId),
    onMutate: () => setDependencyError(""),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: taskKey }); },
    onError: (error) => setDependencyError(error instanceof Error ? error.message : "Dependency could not be added."),
  });
  const removeDependency = useMutation({
    mutationFn: (dependencyTaskId: string) => workspaceApi.removeDependency(projectId, taskId, dependencyTaskId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: taskKey }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Dependency could not be removed"),
  });
  const deleteTask = useMutation({
    mutationFn: (expectedVersion: number) => workspaceApi.deleteTask(projectId, taskId, expectedVersion),
    onSuccess: () => {
      removeTaskFromCache(queryClient, projectId, taskId);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDeleteOpen(false);
      toast.success("Task deleted");
      onClose();
    },
    onError: (error) => {
      if (error instanceof WorkspaceApiError && error.status === 409) setConflictOpen(true);
      else toast.error(error instanceof Error ? error.message : "Task could not be deleted");
    },
  });

  if (query.isLoading || !task) {
    return <div className="h-full bg-[var(--panel)] p-5"><div className="h-8 w-2/3 animate-pulse rounded bg-[var(--skeleton)]" /><div className="mt-6 space-y-3">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-[var(--skeleton)]" />)}</div></div>;
  }

  const dependencyCandidates = candidateQuery.data?.items.filter((item) => item.id !== task.id && !task.dependencyIds.includes(item.id)).slice(0, 10) ?? [];
  const title = draft.taskId === task.id ? draft.title : task.title;
  const description = draft.taskId === task.id ? draft.description : task.description;
  const saveTextFields = () => update.mutate({ title: title.trim() || task.title, description, expectedVersion: task.version });

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--panel)]" aria-label={`Task details for ${task.title}`}>
      <header className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--panel)] px-5 pt-4 pb-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[11px] font-semibold text-[var(--text-muted)]">{task.key}</span>
          <button className="text-[var(--text-muted)] hover:text-[var(--text)]" aria-label="Copy task key" onClick={() => { void navigator.clipboard?.writeText(task.key); toast.success("Task key copied"); }}><Copy className="size-3.5" /></button>
          <span className="ml-auto"><OptimisticStateIndicator state={task.syncState} /></span>
          <Button variant="ghost" size="icon" aria-label="More task actions" onClick={() => setDeleteOpen(true)}><MoreHorizontal className="size-4" /></Button>
          <Button variant="ghost" size="icon" aria-label="Close task details" onClick={onClose}><X className="size-4" /></Button>
        </div>
        <Input value={title} onChange={(event) => setDraft({ taskId: task.id, title: event.target.value, description })} className="h-auto min-w-0 truncate rounded-none border-0 bg-transparent px-0 py-1 text-lg font-semibold shadow-none focus:bg-transparent focus:ring-0" aria-label="Task title" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
          <section aria-labelledby="properties-heading" className="rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 sm:p-5">
            <h2 id="properties-heading" className="section-label">Properties</h2>
            <div className="mt-3 grid grid-cols-[112px_minmax(0,1fr)] items-center gap-y-3 text-sm">
              <span className="text-[var(--text-muted)]">Status</span><TaskStatusSelect value={task.status} disabled={update.isPending} onChange={(status) => update.mutate({ status, expectedVersion: task.version })} />
              <span className="text-[var(--text-muted)]">Priority</span><PrioritySelect value={task.priority} disabled={update.isPending} onChange={(priority) => update.mutate({ priority, expectedVersion: task.version })} />
              <span className="text-[var(--text-muted)]">Assignees</span>
              <AssigneePicker projectId={projectId} assignedIds={task.assigneeIds} memberPreview={members} disabled={update.isPending} onChange={(assigneeIds) => update.mutate({ assigneeIds, expectedVersion: task.version })} />
              <span className="text-[var(--text-muted)]">Tags</span>
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {task.tags.map((tag) => <Badge key={tag} className="border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-secondary)]">{tag}<button type="button" aria-label={`Remove ${tag} tag`} disabled={update.isPending} onClick={() => update.mutate({ tags: task.tags.filter((item) => item !== tag), expectedVersion: task.version })} className="rounded-sm text-[var(--text-muted)] hover:text-[var(--danger)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]"><X className="size-3" /></button></Badge>)}
                </div>
                <div className="flex gap-2"><Input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && tagDraft.trim()) { event.preventDefault(); update.mutate({ tags: [...new Set([...task.tags, tagDraft.trim().toLowerCase()])], expectedVersion: task.version }, { onSuccess: () => setTagDraft("") }); } }} className="h-8 text-xs" placeholder="Add a tag" aria-label="New task tag" /><Button size="sm" variant="secondary" disabled={!tagDraft.trim() || update.isPending} onClick={() => update.mutate({ tags: [...new Set([...task.tags, tagDraft.trim().toLowerCase()])], expectedVersion: task.version }, { onSuccess: () => setTagDraft("") })}>Add</Button></div>
              </div>
              <span className="text-[var(--text-muted)]">Custom fields</span>
              <div className="flex flex-wrap gap-1.5">{Object.entries(task.customFields).length ? Object.entries(task.customFields).map(([key, value]) => <Badge key={key} className="border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">{key}</span>{String(value)}</Badge>) : <span className="text-xs text-[var(--text-muted)]">None configured</span>}</div>
            </div>
          </section>

          <section aria-labelledby="description-heading" className="rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 sm:p-5">
            <h2 id="description-heading" className="section-label">Description</h2>
            <Textarea value={description} onChange={(event) => setDraft({ taskId: task.id, title, description: event.target.value })} rows={5} className="mt-3" placeholder="Describe the outcome, context, and acceptance criteria…" />
            {(description !== task.description || title !== task.title) && <div className="mt-2 flex justify-end"><Button size="sm" onClick={saveTextFields} disabled={update.isPending}><Save className="size-3.5" />Save changes</Button></div>}
          </section>

          <section aria-labelledby="dependencies-heading" className="rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 sm:p-5">
            <div className="flex items-center justify-between"><h2 id="dependencies-heading" className="section-label">Dependencies</h2><Link2 className="size-4 text-[var(--text-muted)]" /></div>
            <div className="mt-3 space-y-2">
              {task.dependencyIds.map((id) => {
                const linked = candidateQuery.data?.items.find((item) => item.id === id);
                return <div key={id} className="flex w-full items-center gap-1 rounded-lg border border-[var(--border)] pr-1"><button onClick={() => onOpenTask(id)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--hover)]"><Check className="size-3.5 text-[var(--success)]" /><span className="min-w-0 flex-1 truncate">{linked?.title ?? id.slice(0, 8)}</span><ChevronRight className="size-3.5 text-[var(--text-muted)]" /></button><Button variant="ghost" size="icon" className="size-7" aria-label={`Remove dependency ${linked?.title ?? id}`} disabled={removeDependency.isPending} onClick={() => removeDependency.mutate(id)}><X className="size-3.5" /></Button></div>;
              })}
              {!task.dependencyIds.length && <p className="text-xs text-[var(--text-muted)]">No dependencies yet.</p>}
              <Select label="Add dependency" value="add" onValueChange={(id) => { if (id !== "add") dependencyMutation.mutate(id); }} disabled={dependencyMutation.isPending} options={[{ value: "add", label: "+ Add dependency" }, ...dependencyCandidates.map((item) => ({ value: item.id, label: `${item.key} · ${item.title}` }))]} className="w-full" />
              {dependencyError && <p className="flex items-start gap-1.5 text-xs text-[var(--danger-text)]"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{dependencyError}</p>}
              <p className="text-[10px] text-[var(--text-muted)]">Cycle-forming dependency edges are rejected transactionally.</p>
            </div>
          </section>
        </div>

        <Tabs.Root defaultValue="comments" className="mx-4 mb-4 flex min-h-[390px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-raised)] sm:mx-5 sm:mb-5">
          <Tabs.List className="flex h-12 shrink-0 gap-5 border-b border-[var(--border-subtle)] px-5" aria-label="Task collaboration">
            <Tabs.Trigger value="comments" className="border-b-2 border-transparent text-xs font-semibold text-[var(--text-muted)] outline-none data-[state=active]:border-[var(--brand)] data-[state=active]:text-[var(--text)]"><MessageSquare className="mr-1.5 inline size-3.5" />Comments <span className="ml-1 rounded-full border border-[var(--border)] bg-[var(--panel)] px-1.5">{task.commentCount}</span></Tabs.Trigger>
            <Tabs.Trigger value="activity" className="border-b-2 border-transparent text-xs font-semibold text-[var(--text-muted)] outline-none data-[state=active]:border-[var(--brand)] data-[state=active]:text-[var(--text)]"><Activity className="mr-1.5 inline size-3.5" />Activity</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="comments" className="flex min-h-[340px] flex-1 flex-col outline-none"><CommentThread projectId={projectId} taskId={taskId} members={members} /></Tabs.Content>
          <Tabs.Content value="activity" className="outline-none"><AssignmentHistory projectId={projectId} taskId={taskId} members={members} /></Tabs.Content>
        </Tabs.Root>
      </div>

      <Dialog open={conflictOpen} onOpenChange={setConflictOpen} title="A newer version is available" description="This task changed on another client while you were editing. Review the latest server state before applying your changes again.">
        <div className="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-sm text-[var(--warning-text)]"><AlertTriangle className="mr-2 inline size-4" />Server version {task.version + 1} is newer than your edit.</div>
        <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={() => setConflictOpen(false)}>Keep editing</Button><Button onClick={() => { void query.refetch(); setConflictOpen(false); }}>Load server version</Button></div>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete this task?" description="The task, its comments, assignments, tags, and dependency edges will be removed in one transaction. This action cannot be undone.">
        <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-sm text-[var(--danger-text)]"><Trash2 className="mr-2 inline size-4" />Delete {task.key} · {task.title}</div>
        <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" disabled={deleteTask.isPending} onClick={() => deleteTask.mutate(task.version)}>{deleteTask.isPending ? "Deleting…" : "Delete task"}</Button></div>
      </Dialog>
    </section>
  );
}
