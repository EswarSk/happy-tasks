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
  queryClient.setQueriesData<InfiniteData<Page<Task>>>({ queryKey: ["tasks", projectId] }, (current) => {
    if (!current || !current.pages[0]) return current;
    const [first, ...rest] = current.pages;
    return {
      ...current,
      pages: [{ ...first, items: [task, ...first.items], totalCount: first.totalCount + 1 }, ...rest],
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
  queryClient.setQueryData<Task>(["task", projectId, taskId], (current) =>
    current ? { ...current, commentCount: current.commentCount + 1 } : current,
  );
  queryClient.setQueriesData<InfiniteData<Page<Task>>>({ queryKey: ["tasks", projectId] }, (current) => {
    if (!current) return current;
    return {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        items: page.items.map((task) =>
          task.id === taskId ? { ...task, commentCount: task.commentCount + 1 } : task,
        ),
      })),
    };
  });
}
