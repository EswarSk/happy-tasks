"use client";

import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Check, ChevronRight, Copy, Link2, Maximize2, MessageSquare, Minimize2, MoreHorizontal, Redo2, Save, Search, Trash2, Undo2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { OptimisticStateIndicator } from "@/components/patterns/optimistic-state";
import { PrioritySelect, StatusIcon, TaskStatusSelect, statusLabels } from "@/components/patterns/task-badges";
import { CommentThread } from "@/features/comments/comment-thread";
import { AssigneePicker } from "./assignee-picker";
import { AssignmentHistory } from "./assignment-history";
import { CollaborativeDescription } from "./collaborative-description";
import { TaskDependencyGraph } from "./task-dependency-graph";
import { patchTaskInCache, removeTaskFromCache } from "./query-cache";
import type { Member, Task, UpdateTaskInput } from "@/lib/api";
import { WorkspaceApiError, dataSource, workspaceApi } from "@/lib/api";
import type { CollaboratorPresence } from "@/features/collaboration/use-project-presence";

interface TaskDetailPanelProps {
  projectId: string;
  taskId: string;
  members: Member[];
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onToggleExpand?: () => void;
  detailExpanded?: boolean;
  collaborators?: CollaboratorPresence[];
  onSelectionChange?: (from: number, to: number) => void;
}

export function TaskDetailPanel({ projectId, taskId, members, collaborators = [], onSelectionChange, onClose, onOpenTask, onToggleExpand, detailExpanded = false }: TaskDetailPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ taskId: "", description: "", title: "" });
  const [conflictOpen, setConflictOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dependencyError, setDependencyError] = useState("");
  const [dependencySearch, setDependencySearch] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [customFieldsDrafts, setCustomFieldsDrafts] = useState<Record<string, Record<string, string>>>({});
  const [customFieldKey, setCustomFieldKey] = useState("");
  const [customFieldValue, setCustomFieldValue] = useState("");
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
      setCustomFieldsDrafts((current) => ({ ...current, [saved.id]: saved.customFields }));
      if (input.assigneeIds) void queryClient.invalidateQueries({ queryKey: ["assignment-history", projectId, taskId] });
    },
  });

  const relatedTasksQuery = useQuery({
    queryKey: ["dependency-related", projectId, taskId],
    queryFn: () => workspaceApi.listTasks(projectId, { limit: 100 }),
    enabled: Boolean(task),
  });
  const candidateQuery = useQuery({
    queryKey: ["dependency-candidates", projectId, taskId, dependencySearch],
    queryFn: () => workspaceApi.listTasks(projectId, { limit: 100, search: dependencySearch }),
    enabled: Boolean(task),
  });

  const dependencyMutation = useMutation({
    mutationFn: (dependencyTaskId: string) => workspaceApi.addDependency(projectId, taskId, dependencyTaskId),
    onMutate: async (dependencyTaskId) => {
      setDependencyError("");
      await queryClient.cancelQueries({ queryKey: taskKey });
      const previous = queryClient.getQueryData<Task>(taskKey);
      if (previous && !previous.dependencyIds.includes(dependencyTaskId)) {
        patchTaskInCache(queryClient, projectId, { ...previous, dependencyIds: [...previous.dependencyIds, dependencyTaskId], syncState: "pending" });
      }
      return { previous };
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: taskKey }); },
    onError: (error, _dependencyTaskId, context) => {
      if (context?.previous) patchTaskInCache(queryClient, projectId, context.previous);
      setDependencyError(error instanceof Error ? error.message : "Dependency could not be added.");
    },
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

  const undoTask = useMutation({
    mutationFn: () => workspaceApi.undoTask(projectId, taskId),
    onSuccess: (saved) => {
      patchTaskInCache(queryClient, projectId, { ...saved, syncState: "synced" });
      setDraft({ taskId: saved.id, title: saved.title, description: saved.description });
      toast.success("Last task edit undone");
    },
    onError: (error) => {
      if (error instanceof WorkspaceApiError && (error.status === 409 || error.apiError.code === "OPERATION_CONFLICT")) setConflictOpen(true);
      else toast.error(error instanceof Error ? error.message : "Nothing to undo");
    },
  });

  const redoTask = useMutation({
    mutationFn: () => workspaceApi.redoTask(projectId, taskId),
    onSuccess: (saved) => {
      patchTaskInCache(queryClient, projectId, { ...saved, syncState: "synced" });
      setDraft({ taskId: saved.id, title: saved.title, description: saved.description });
      toast.success("Task edit redone");
    },
    onError: (error) => {
      if (error instanceof WorkspaceApiError && (error.status === 409 || error.apiError.code === "OPERATION_CONFLICT")) setConflictOpen(true);
      else toast.error(error instanceof Error ? error.message : "Nothing to redo");
    },
  });

  if (query.isLoading || !task) {
    return <div className="h-full bg-[var(--panel)] p-5"><div className="h-8 w-2/3 animate-pulse rounded bg-[var(--skeleton)]" /><div className="mt-6 space-y-3">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-[var(--skeleton)]" />)}</div></div>;
  }

  const dependencyCandidates = candidateQuery.data?.items.filter((item) => item.id !== task.id && !task.dependencyIds.includes(item.id)).slice(0, 10) ?? [];
  const customFields = customFieldsDrafts[task.id] ?? task.customFields;
  const customFieldsChanged = JSON.stringify(customFields) !== JSON.stringify(task.customFields);
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
          <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label="Undo last task edit" title="Undo last task edit" disabled={undoTask.isPending || redoTask.isPending} onClick={() => undoTask.mutate()}><Undo2 className="size-4" /></Button>
          <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label="Redo task edit" title="Redo task edit" disabled={undoTask.isPending || redoTask.isPending} onClick={() => redoTask.mutate()}><Redo2 className="size-4" /></Button>
          {onToggleExpand && <Button variant="ghost" size="icon" className="hidden lg:inline-flex" aria-label={detailExpanded ? "Restore split view" : "Expand task details"} title={detailExpanded ? "Restore split view" : "Expand task details"} onClick={onToggleExpand}>{detailExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button>}
          <Button variant="ghost" size="icon" aria-label="More task actions" onClick={() => setDeleteOpen(true)}><MoreHorizontal className="size-4" /></Button>
          <Button variant="ghost" size="icon" aria-label="Close task details" onClick={onClose}><X className="size-4" /></Button>
        </div>
        <Input value={title} onChange={(event) => setDraft({ taskId: task.id, title: event.target.value, description })} className="h-auto min-w-0 truncate rounded-none border-0 bg-transparent px-0 py-1 text-lg font-semibold shadow-none focus:bg-transparent focus:ring-0" aria-label="Task title" />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-0 px-4 py-4 sm:px-5 sm:py-5">
          <TaskDependencyGraph task={task} relatedTasks={relatedTasksQuery.data?.items ?? []} isLoading={relatedTasksQuery.isLoading} onOpenTask={onOpenTask} />

          <section aria-labelledby="properties-heading" className="border-b border-[var(--border-subtle)] pb-5">
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
              <div className="space-y-2">
                {Object.entries(customFields).map(([key, value]) => <div key={key} className="flex items-center gap-2"><Input value={String(value)} onChange={(event) => setCustomFieldsDrafts((current) => ({ ...current, [task.id]: { ...customFields, [key]: event.target.value } }))} aria-label={`Custom field ${key}`} className="h-8 text-xs" /><Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Remove custom field ${key}`} onClick={() => setCustomFieldsDrafts((current) => ({ ...current, [task.id]: Object.fromEntries(Object.entries(customFields).filter(([currentKey]) => currentKey !== key)) }))}><X className="size-3.5" /></Button></div>)}
                {!Object.entries(customFields).length && <span className="text-xs text-[var(--text-muted)]">None configured</span>}
                <div className="grid grid-cols-2 gap-2"><Input value={customFieldKey} onChange={(event) => setCustomFieldKey(event.target.value)} aria-label="New custom field name" placeholder="Field name" className="h-8 text-xs" /><Input value={customFieldValue} onChange={(event) => setCustomFieldValue(event.target.value)} aria-label="New custom field value" placeholder="Value" className="h-8 text-xs" /></div>
                <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="secondary" disabled={!customFieldKey.trim()} onClick={() => { const key = customFieldKey.trim(); setCustomFieldsDrafts((current) => ({ ...current, [task.id]: { ...customFields, [key]: customFieldValue } })); setCustomFieldKey(""); setCustomFieldValue(""); }}>Add field</Button>{customFieldsChanged && <Button type="button" size="sm" onClick={() => update.mutate({ customFields, expectedVersion: task.version })} disabled={update.isPending}><Save className="size-3.5" />Save fields</Button>}</div>
              </div>
            </div>
          </section>

          <section aria-labelledby="description-heading" className="border-b border-[var(--border-subtle)] py-5">
            <h2 id="description-heading" className="section-label">Description</h2>
            {dataSource === "api" ? <>
              <CollaborativeDescription key={task.id} projectId={projectId} taskId={task.id} initialValue={description} collaborators={collaborators} onSelectionChange={onSelectionChange} onValueChange={(next) => setDraft({ taskId: task.id, title, description: next })} />
              {title !== task.title && <div className="mt-2 flex justify-end"><Button size="sm" onClick={() => update.mutate({ title: title.trim() || task.title, expectedVersion: task.version })} disabled={update.isPending}><Save className="size-3.5" />Save title</Button></div>}
            </> : <>
              <Textarea value={description} onChange={(event) => setDraft({ taskId: task.id, title, description: event.target.value })} rows={5} className="mt-3" placeholder="Describe the outcome, context, and acceptance criteria…" />
              {(description !== task.description || title !== task.title) && <div className="mt-2 flex justify-end"><Button size="sm" onClick={saveTextFields} disabled={update.isPending}><Save className="size-3.5" />Save changes</Button></div>}
            </>}
          </section>

          <section aria-labelledby="dependencies-heading" className="border-b border-[var(--border-subtle)] py-5">
            <div className="flex items-center justify-between"><h2 id="dependencies-heading" className="section-label">Dependencies</h2><Link2 className="size-4 text-[var(--text-muted)]" /></div>
            <div className="mt-3 space-y-2">
              {task.dependencyIds.map((id) => {
                const linked = candidateQuery.data?.items.find((item) => item.id === id);
                return <div key={id} className="flex w-full items-center gap-1 rounded-md border border-[var(--border)] pr-1"><button onClick={() => onOpenTask(id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-xs outline-none hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]"><Check className="size-3.5 text-[var(--success)]" /><span className="min-w-0 flex-1 truncate">{linked?.title ?? id.slice(0, 8)}</span><ChevronRight className="size-3.5 text-[var(--text-muted)]" /></button><Button variant="ghost" size="icon" className="size-7" aria-label={`Remove dependency ${linked?.title ?? id}`} disabled={removeDependency.isPending} onClick={() => removeDependency.mutate(id)}><X className="size-3.5" /></Button></div>;
              })}
              {!task.dependencyIds.length && <p className="text-xs text-[var(--text-muted)]">No dependencies yet.</p>}
              <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" /><Input value={dependencySearch} onChange={(event) => setDependencySearch(event.target.value)} aria-label="Search dependencies" placeholder="Search tasks to add…" className="h-9 pl-9 text-xs" /></div>
              {dependencyCandidates.length > 0 && <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-[var(--border)] p-1" role="listbox" aria-label="Dependency candidates">{dependencyCandidates.map((item) => <button key={item.id} type="button" role="option" aria-selected="false" disabled={dependencyMutation.isPending} onClick={() => { dependencyMutation.mutate(item.id); setDependencySearch(""); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><span className="min-w-0 flex-1 truncate"><span className="font-mono text-[10px] text-[var(--text-muted)]">{item.key}</span> · {item.title}</span><span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--text-muted)]"><StatusIcon status={item.status} />{statusLabels[item.status]} · blocks {item.blockingCount}</span></button>)}</div>}
              {!candidateQuery.isLoading && dependencySearch && !dependencyCandidates.length && <p className="text-xs text-[var(--text-muted)]">No matching tasks in this project.</p>}
              {dependencyError && <p className="flex items-start gap-1.5 text-xs text-[var(--danger-text)]"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{dependencyError}</p>}
              <p className="text-[10px] text-[var(--text-muted)]">Cycle-forming dependency edges are rejected transactionally.</p>
            </div>
          </section>
        </div>

        <Tabs.Root defaultValue="comments" className="mx-4 mb-4 flex min-h-[390px] flex-col overflow-hidden border-t border-[var(--border-subtle)] sm:mx-5 sm:mb-5">
          <Tabs.List className="flex h-12 shrink-0 gap-5 border-b border-[var(--border-subtle)] px-5" aria-label="Task collaboration">
            <Tabs.Trigger value="comments" className="border-b-2 border-transparent text-xs font-semibold text-[var(--text-muted)] outline-none data-[state=active]:border-[var(--brand)] data-[state=active]:text-[var(--text)]"><MessageSquare className="mr-1.5 inline size-3.5" />Comments <span className="ml-1 rounded-full border border-[var(--border)] bg-[var(--panel)] px-1.5">{task.commentCount}</span></Tabs.Trigger>
            <Tabs.Trigger value="activity" className="border-b-2 border-transparent text-xs font-semibold text-[var(--text-muted)] outline-none data-[state=active]:border-[var(--brand)] data-[state=active]:text-[var(--text)]"><Activity className="mr-1.5 inline size-3.5" />Activity</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="comments" className="flex min-h-[340px] flex-1 flex-col outline-none"><CommentThread projectId={projectId} taskId={taskId} members={members} /></Tabs.Content>
          <Tabs.Content value="activity" className="outline-none">
            <div className="px-5 pt-4 text-[11px] font-semibold tracking-[.07em] text-[var(--text-muted)] uppercase">Assignment history</div>
            <AssignmentHistory projectId={projectId} taskId={taskId} members={members} />
          </Tabs.Content>
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
