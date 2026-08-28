"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, AlertCircle, ArrowUpRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { Member } from "@/lib/api";
import { workspaceApi } from "@/lib/api";
import { relativeTime } from "@/lib/utils";

export function ActivityFeed({ projectId, members }: { projectId: string; members: Member[] }) {
  const membersById = new Map(members.map((member) => [member.id, member]));
  const query = useInfiniteQuery({
    queryKey: ["activity", projectId],
    queryFn: ({ pageParam }) => workspaceApi.listActivity(projectId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isLoading) return <div className="space-y-3 p-5">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-16 animate-pulse rounded-xl bg-[var(--skeleton)]" />)}</div>;
  if (query.isError) return <div className="grid h-full place-items-center p-8 text-center"><div><AlertCircle className="mx-auto mb-3 size-6 text-[var(--danger)]" /><h2 className="font-semibold">Activity could not be loaded</h2><Button variant="secondary" className="mt-4" onClick={() => query.refetch()}><RefreshCw className="size-4" />Retry</Button></div></div>;
  if (!items.length) return <div className="grid h-full place-items-center p-8 text-center"><Activity className="mx-auto mb-3 size-7 text-[var(--text-muted)]" /><h2 className="font-semibold">No activity yet</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">Changes to this project will appear here.</p></div>;

  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-3xl space-y-2 p-4 sm:p-8">
    <div className="mb-6"><p className="section-label">Project timeline</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Recent activity</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">A compact view of the durable changes shared with collaborators.</p></div>
    {items.map((item) => {
      const actor = membersById.get(item.actorId);
      const target = item.aggregateType === "task" ? `/projects/${projectId}/tasks/${item.aggregateId}` : undefined;
      const content = <div className="flex min-w-0 flex-1 items-start gap-3"><Avatar name={actor?.displayName ?? "Collaborator"} color={actor?.color} className="mt-0.5" /><div className="min-w-0 flex-1"><p className="text-sm"><strong className="font-semibold">{actor?.displayName ?? "A collaborator"}</strong> <span className="text-[var(--text-secondary)]">{item.description}</span></p><div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]"><time>{relativeTime(item.occurredAt)}</time><span aria-hidden="true">·</span><span className="font-mono">#{item.sequence}</span></div></div>{target && <ArrowUpRight className="mt-1 size-4 shrink-0 text-[var(--text-muted)]" />}</div>;
      return target ? <Link key={item.id} href={target} className="block rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">{content}</Link> : <div key={item.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">{content}</div>;
    })}
    {query.hasNextPage && <div className="pt-3 text-center"><Button variant="secondary" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more activity"}</Button></div>}
  </div></div>;
}
