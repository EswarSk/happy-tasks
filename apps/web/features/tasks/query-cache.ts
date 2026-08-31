import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Page, Task } from "@/lib/api";

export function patchTaskInCache(queryClient: QueryClient, projectId: string, task: Task) {
  queryClient.setQueryData<Task>(["task", projectId, task.id], task);
  queryClient.setQueriesData<InfiniteData<Page<Task>>>({ queryKey: ["tasks", projectId] }, (current) => {
    if (!current) return current;
    return {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        items: page.items.map((item) => (item.id === task.id ? { ...task } : item)),
      })),
    };
  });
}

export function prependTaskToCache(queryClient: QueryClient, projectId: string, task: Task) {
  queryClient.setQueryData<Task>(["task", projectId, task.id], task);
  queryClient.setQueriesData<InfiniteData<Page<Task>>>({ queryKey: ["tasks", projectId] }, (current) => {
    if (!current || !current.pages[0]) return current;
    const alreadyPresent = current.pages.some((page) => page.items.some((item) => item.id === task.id));
    const pages = current.pages.map((page, index) => ({
      ...page,
      // A task.created SSE event can arrive before the mutation response. Keep
      // this helper idempotent so the response never creates a second row.
      items: alreadyPresent
        ? page.items.map((item) => (item.id === task.id ? task : item))
        : index === 0
          ? [task, ...page.items]
          : page.items,
      totalCount: alreadyPresent || index !== 0 ? page.totalCount : page.totalCount + 1,
    }));
    return {
      ...current,
      pages,
    };
  });
}

export function removeTaskFromCache(queryClient: QueryClient, projectId: string, taskId: string) {
  queryClient.removeQueries({ queryKey: ["task", projectId, taskId] });
  queryClient.setQueriesData<InfiniteData<Page<Task>>>({ queryKey: ["tasks", projectId] }, (current) => {
    if (!current) return current;
    return {
      ...current,
      pages: current.pages.map((page) => {
        const removed = page.items.some((item) => item.id === taskId);
        return {
          ...page,
          items: page.items.filter((item) => item.id !== taskId),
          totalCount: Math.max(0, page.totalCount - (removed ? 1 : 0)),
        };
      }),
    };
  });
}

export function incrementTaskCommentCount(queryClient: QueryClient, projectId: string, taskId: string) {
  adjustTaskCommentCount(queryClient, projectId, taskId, 1);
}

export function decrementTaskCommentCount(queryClient: QueryClient, projectId: string, taskId: string) {
  adjustTaskCommentCount(queryClient, projectId, taskId, -1);
}

function adjustTaskCommentCount(queryClient: QueryClient, projectId: string, taskId: string, delta: number) {
  queryClient.setQueryData<Task>(["task", projectId, taskId], (current) =>
    current ? { ...current, commentCount: Math.max(0, current.commentCount + delta) } : current,
  );
  queryClient.setQueriesData<InfiniteData<Page<Task>>>({ queryKey: ["tasks", projectId] }, (current) => {
    if (!current) return current;
    return {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        items: page.items.map((task) =>
          task.id === taskId ? { ...task, commentCount: Math.max(0, task.commentCount + delta) } : task,
        ),
      })),
    };
  });
}
