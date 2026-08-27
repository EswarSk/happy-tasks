"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { Member } from "@/lib/api";
import { workspaceApi } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

interface AssignmentHistoryProps {
  projectId: string;
  taskId: string;
  members: Member[];
}

export function AssignmentHistory({ projectId, taskId, members }: AssignmentHistoryProps) {
  const query = useInfiniteQuery({
    queryKey: ["assignment-history", projectId, taskId],
    queryFn: ({ pageParam }) => workspaceApi.listAssignmentHistory(projectId, taskId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const memberById = new Map(members.map((member) => [member.id, member]));

  if (query.isLoading) return <p className="p-5 text-xs text-[var(--text-muted)]">Loading assignment history…</p>;
  if (query.isError) return <div className="p-5"><p className="text-xs text-[var(--danger-text)]">Assignment history could not be loaded.</p><Button variant="secondary" size="sm" className="mt-3" onClick={() => query.refetch()}>Try again</Button></div>;
  if (!items.length) return <p className="p-5 text-xs text-[var(--text-muted)]">No assignment changes yet.</p>;

  return (
    <div className="p-5">
      {items.map((item) => {
        const actor = memberById.get(item.actorId);
        const subject = memberById.get(item.userId);
        const actorName = actor?.displayName ?? "A project member";
        const subjectName = subject?.displayName ?? "a former member";
        return (
          <div key={item.id} className="relative flex gap-3 pb-5 text-xs before:absolute before:top-6 before:bottom-0 before:left-3 before:w-px before:bg-[var(--border)] last:pb-0 last:before:hidden">
            <Avatar name={actorName} color={actor?.color} className="size-6" />
            <div><p className="text-[var(--text-secondary)]"><span className="font-medium text-[var(--text)]">{actorName}</span> {item.operation === "ASSIGNED" ? "assigned" : "unassigned"} <span className="font-medium text-[var(--text)]">{subjectName}</span></p><p className="mt-1 text-[var(--text-muted)]">{relativeTime(item.occurredAt)}</p></div>
          </div>
        );
      })}
      {query.hasNextPage && <Button variant="ghost" size="sm" className="w-full" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load older changes"}</Button>}
    </div>
  );
}
