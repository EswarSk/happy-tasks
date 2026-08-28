import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { Comment, Page, Task } from "@/lib/api";
import { applyEvent } from "./use-project-events";

const projectId = "project-1";
const task: Task = {
  id: "task-1",
  projectId,
  key: "TSK-1",
  title: "Coordinate launch",
  description: "",
  status: "todo",
  priority: "high",
  assigneeIds: [],
  tags: [],
  dependencyIds: [],
  blockingCount: 0,
  commentCount: 0,
  customFields: {},
  updatedAt: "2026-08-27T00:00:00.000Z",
  version: 1,
};

function queryClientWithTask() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["task", projectId, task.id], task);
  queryClient.setQueryData<InfiniteData<Page<Task>>>(["tasks", projectId], {
    pages: [{ items: [task], nextCursor: null, totalCount: 1 }],
    pageParams: [undefined],
  });
  queryClient.setQueryData<InfiniteData<Page<Comment>>>(["comments", projectId, task.id], {
    pages: [{ items: [], nextCursor: null, totalCount: 0 }],
    pageParams: [undefined],
  });
  return queryClient;
}

describe("project event reconciliation", () => {
  it("adds a remote comment and updates cached task counters", () => {
    const queryClient = queryClientWithTask();

    applyEvent(queryClient, {
      projectId,
      sequence: 2,
      type: "comment.created",
      aggregateId: "comment-1",
      payload: {
        id: "comment-1",
        taskId: task.id,
        parentId: "parent-comment",
        author: { id: "user-1" },
        body: "Ready for review",
        createdAt: "2026-08-27T00:01:00.000Z",
        version: 1,
      },
    });

    expect(queryClient.getQueryData<Task>(["task", projectId, task.id])?.commentCount).toBe(1);
    expect(queryClient.getQueryData<InfiniteData<Page<Comment>>>(["comments", projectId, task.id])?.pages[0]?.items).toHaveLength(1);
    expect(queryClient.getQueryData<InfiniteData<Page<Comment>>>(["comments", projectId, task.id])?.pages[0]?.items[0]?.parentId).toBe("parent-comment");
    expect(queryClient.getQueryData<InfiniteData<Page<Task>>>(["tasks", projectId])?.pages[0]?.items[0]?.commentCount).toBe(1);
  });

  it("invalidates affected task data for remote dependency changes", () => {
    const queryClient = queryClientWithTask();

    applyEvent(queryClient, {
      projectId,
      sequence: 3,
      type: "dependency.created",
      aggregateId: task.id,
      payload: { taskId: task.id, dependsOnTaskId: "task-2" },
    });

    expect(queryClient.getQueryState(["task", projectId, task.id])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["tasks", projectId])?.isInvalidated).toBe(true);
  });

  it("does not double-count a comment already inserted optimistically", () => {
    const queryClient = queryClientWithTask();
    queryClient.setQueryData<InfiniteData<Page<Comment>>>(["comments", projectId, task.id], {
      pages: [{
        items: [{ id: "comment-1", projectId, taskId: task.id, authorId: "user-1", body: "Pending", createdAt: "2026-08-27T00:01:00.000Z", version: 0 }],
        nextCursor: null,
        totalCount: 1,
      }],
      pageParams: [undefined],
    });

    applyEvent(queryClient, {
      projectId,
      sequence: 4,
      type: "comment.created",
      aggregateId: "comment-1",
      payload: { id: "comment-1", taskId: task.id, author: { id: "user-1" }, body: "Pending", version: 1 },
    });

    expect(queryClient.getQueryData<Task>(["task", projectId, task.id])?.commentCount).toBe(0);
  });
});
