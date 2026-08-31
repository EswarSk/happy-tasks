"use client";

import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ActivityItem, Comment, ConnectionState, Page, Task, TaskPriority, TaskStatus } from "@/lib/api";
import { createSseParser } from "@/lib/realtime/sse";
import { incrementTaskCommentCount } from "@/features/tasks/query-cache";

export interface SyncEvent {
  projectId: string;
  sequence: number;
  type: string;
  aggregateId: string;
  aggregateType?: string;
  actorId?: string;
  aggregateVersion?: number;
  payload: Record<string, unknown> & { task?: Record<string, unknown>; comment?: Record<string, unknown> };
}

function normalizeEventTask(payload: Record<string, unknown>, existing?: Task): Task | undefined {
  const id = String(payload.id ?? existing?.id ?? "");
  if (!id) return undefined;
  return {
    id,
    projectId: String(payload.projectId ?? existing?.projectId ?? ""),
    key: String(payload.key ?? existing?.key ?? `TSK-${id.replaceAll("-", "").slice(-6).toUpperCase()}`),
    title: String(payload.title ?? existing?.title ?? "Untitled task"),
    description: String(payload.description ?? existing?.description ?? ""),
    status: String(payload.status ?? existing?.status ?? "todo").toLowerCase() as TaskStatus,
    priority: String(payload.priority ?? existing?.priority ?? "medium").toLowerCase() as TaskPriority,
    assigneeIds: (payload.assigneeIds ?? existing?.assigneeIds ?? []) as string[],
    tags: (payload.tags ?? existing?.tags ?? []) as string[],
    dependencyIds: (payload.dependencyIds ?? existing?.dependencyIds ?? []) as string[],
    blockingCount: Number(payload.blockingCount ?? existing?.blockingCount ?? 0),
    commentCount: Number(payload.commentCount ?? existing?.commentCount ?? 0),
    customFields: (payload.customFields ?? existing?.customFields ?? {}) as Record<string, string>,
    updatedAt: String(payload.updatedAt ?? existing?.updatedAt ?? new Date().toISOString()),
    version: Number(payload.version ?? existing?.version ?? 1),
    syncState: "synced",
  };
}

function applyTaskEvent(queryClient: QueryClient, projectId: string, payload: Record<string, unknown>) {
  const id = String(payload.id ?? "");
  const existing = queryClient.getQueryData<Task>(["task", projectId, id]);
  const task = normalizeEventTask(payload, existing);
  if (!task || (existing && task.version < existing.version)) return;
  queryClient.setQueryData(["task", projectId, id], task);
  queryClient.setQueriesData<InfiniteData<Page<Task>>>({ queryKey: ["tasks", projectId] }, (current) => {
    if (!current) return current;
    const exists = current.pages.some((page) => page.items.some((item) => item.id === task.id));
    const pages = current.pages.map((page, index) => ({
      ...page,
      items: page.items.map((item) => item.id === task.id ? normalizeEventTask(payload, item)! : item),
      totalCount: page.totalCount + (!exists && index === 0 ? 1 : 0),
    }));
    if (!exists && pages[0]) pages[0] = { ...pages[0], items: [task, ...pages[0].items] };
    return { ...current, pages };
  });
}

function activityDescription(type: string) {
  return ({
    "project.created": "created the project",
    "task.created": "created a task",
    "task.updated": "updated a task",
    "task.deleted": "deleted a task",
    "comment.created": "added a comment",
    "comment.reaction.changed": "changed a comment reaction",
    "dependency.created": "added a dependency",
    "dependency.deleted": "removed a dependency",
    "membership.created": "added a project member",
    "membership.updated": "updated a project member",
  } as Record<string, string>)[type] ?? type.replaceAll(".", " ");
}

export function applyEvent(queryClient: QueryClient, event: SyncEvent) {
  const wrapped = event.payload.task ?? event.payload.comment;
  const payload = (wrapped ?? event.payload) as Record<string, unknown>;
  queryClient.setQueryData<InfiniteData<Page<ActivityItem>>>(["activity", event.projectId], (current) => {
    if (!current || current.pages.some((page) => page.items.some((item) => item.sequence === event.sequence))) return current;
    const item: ActivityItem = {
      id: `${event.projectId}:${event.sequence}`, projectId: event.projectId, sequence: event.sequence, eventType: event.type,
      aggregateType: event.aggregateType ?? "event", aggregateId: event.aggregateId, actorId: event.actorId ?? "", description: activityDescription(event.type), occurredAt: new Date().toISOString(),
    };
    const pages = [...current.pages];
    pages[0] = { ...pages[0], items: [item, ...pages[0].items] };
    return { ...current, pages };
  });
  if (event.type === "task.created" || event.type === "task.updated" || event.type === "task.description.updated") {
    applyTaskEvent(queryClient, event.projectId, payload);
    if (event.type === "task.created") void queryClient.invalidateQueries({ queryKey: ["projects"] });
    if (event.type === "task.updated") void queryClient.invalidateQueries({ queryKey: ["notifications", event.projectId] });
  }
  if (event.type === "task.deleted") {
    queryClient.removeQueries({ queryKey: ["task", event.projectId, event.aggregateId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", event.projectId] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  }
  if (event.type === "dependency.created" || event.type === "dependency.deleted") {
    const taskId = String(payload.taskId ?? event.aggregateId);
    void queryClient.invalidateQueries({ queryKey: ["task", event.projectId, taskId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", event.projectId] });
  }
  if (event.type === "comment.created") {
    const taskId = String(payload.taskId ?? "");
    const knownComment = queryClient.getQueryData<InfiniteData<Page<Comment>>>(["comments", event.projectId, taskId])?.pages.some((page) => page.items.some((item) => item.id === String(payload.id))) ?? false;
    const comment: Comment = {
      id: String(payload.id), projectId: event.projectId, taskId,
      ...(payload.parentId ? { parentId: String(payload.parentId) } : {}),
      authorId: String(payload.authorId ?? (payload.author as { id?: string } | undefined)?.id ?? ""),
      body: String(payload.body ?? ""), createdAt: String(payload.createdAt ?? new Date().toISOString()),
      version: Number(payload.version ?? 1), syncState: "synced",
    };
    queryClient.setQueryData<InfiniteData<Page<Comment>>>(["comments", event.projectId, taskId], (current) => {
      if (!current?.pages[0] || knownComment) return current;
      const pages = [...current.pages];
      pages[0] = { ...pages[0], items: [comment, ...pages[0].items], totalCount: pages[0].totalCount + 1 };
      return { ...current, pages };
    });
    if (!knownComment) incrementTaskCommentCount(queryClient, event.projectId, taskId);
    void queryClient.invalidateQueries({ queryKey: ["notifications", event.projectId] });
  }
  if (event.type === "comment.reaction.changed") {
    const taskId = String(payload.taskId ?? "");
    void queryClient.invalidateQueries({ queryKey: ["comments", event.projectId, taskId] });
  }
  if (event.type === "membership.created" || event.type === "membership.updated") {
    // Membership changes can remove assignments in one transaction. Refresh both
    // the virtualized list and any open detail query so stale assignee chips do
    // not survive a soft suspension/removal.
    void queryClient.invalidateQueries({ queryKey: ["members", event.projectId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", event.projectId] });
    void queryClient.invalidateQueries({ queryKey: ["task", event.projectId] });
  }
  if (event.type === "attachment.created" || event.type === "attachment.deleted") {
    const taskId = String(payload.taskId ?? event.aggregateId ?? "");
    if (taskId) void queryClient.invalidateQueries({ queryKey: ["attachments", event.projectId, taskId] });
  }
}

export function useProjectEvents(projectId: string, startCursor: number, enabled: boolean) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>(enabled ? "reconnecting" : "live");
  const lastCursor = useRef(startCursor);

  useEffect(() => {
    lastCursor.current = Math.max(lastCursor.current, startCursor);
    if (!enabled) return;
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let attempts = 0;

    const connect = async () => {
      if (controller.signal.aborted) return;
      setState(attempts === 0 ? "reconnecting" : navigator.onLine ? "reconnecting" : "offline");
      try {
        const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
        const response = await fetch(`${baseUrl}/v1/projects/${projectId}/events?after=${lastCursor.current}`, {
          credentials: "include",
          headers: { Accept: "text/event-stream", "Last-Event-ID": String(lastCursor.current) },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`);
        setState("live"); attempts = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser();
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
            const event = JSON.parse(message.data) as SyncEvent;
            if (event.sequence <= lastCursor.current) continue;
            if (event.sequence > lastCursor.current + 1) {
              await queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
            }
            applyEvent(queryClient, event);
            lastCursor.current = event.sequence;
          }
        }
        if (!controller.signal.aborted) throw new Error("Event stream closed");
      } catch {
        if (controller.signal.aborted) return;
        attempts += 1;
        setState(navigator.onLine ? "reconnecting" : "offline");
        retryTimer = window.setTimeout(connect, Math.min(10_000, 250 * 2 ** attempts) + Math.random() * 200);
      }
    };

    void connect();
    return () => { controller.abort(); if (retryTimer) window.clearTimeout(retryTimer); };
  }, [enabled, projectId, queryClient, startCursor]);

  return enabled ? state : "live";
}
