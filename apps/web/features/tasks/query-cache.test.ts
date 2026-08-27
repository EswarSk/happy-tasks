import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Page, Task } from "@/lib/api";
import { prependTaskToCache } from "./query-cache";

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  key: "TSK-1",
  title: "Ship the task",
  description: "",
  status: "todo",
  priority: "medium",
  assigneeIds: [],
  tags: [],
  dependencyIds: [],
  blockingCount: 0,
  commentCount: 0,
  customFields: {},
  updatedAt: "2026-08-27T00:00:00.000Z",
  version: 1,
};

describe("prependTaskToCache", () => {
  it("does not duplicate a task when the SSE event arrived first", () => {
    const queryClient = new QueryClient();
    const key = ["tasks", task.projectId, "", "all", "all"];
    queryClient.setQueryData<InfiniteData<Page<Task>>>(key, {
      pages: [{ items: [task], nextCursor: null, totalCount: 1 }],
      pageParams: [undefined],
    });

    prependTaskToCache(queryClient, task.projectId, task);

    const result = queryClient.getQueryData<InfiniteData<Page<Task>>>(key);
    expect(result?.pages[0]?.items.map((item) => item.id)).toEqual([task.id]);
    expect(result?.pages[0]?.totalCount).toBe(1);
    expect(queryClient.getQueryData<Task>(["task", task.projectId, task.id])?.id).toBe(task.id);
  });
});
