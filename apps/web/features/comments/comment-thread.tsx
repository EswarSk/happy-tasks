"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { AlertCircle, ArrowUp, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { incrementTaskCommentCount } from "@/features/tasks/query-cache";
import type { Comment, Member, Page } from "@/lib/api";
import { dataSource, workspaceApi } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

interface CommentThreadProps {
  projectId: string;
  taskId: string;
  members: Member[];
}

export function CommentThread({ projectId, taskId, members }: CommentThreadProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const commentsKey = ["comments", projectId, taskId];
  const query = useInfiniteQuery({
    queryKey: commentsKey,
    queryFn: ({ pageParam }) => workspaceApi.listComments(projectId, taskId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const comments = query.data ? query.data.pages.flatMap((page) => page.items).reverse() : [];
  const mutation = useMutation({
    mutationFn: ({ body, id }: { body: string; id: string }) => workspaceApi.createComment(projectId, taskId, body, id),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: commentsKey });
      const optimistic: Comment = {
        id: variables.id,
        projectId,
        taskId,
        authorId: members[0]?.id ?? "00000000-0000-7000-8000-000000000001",
        body: variables.body,
        createdAt: new Date().toISOString(),
        version: 0,
        syncState: "pending",
      };
      queryClient.setQueryData<InfiniteData<Page<Comment>, string | undefined>>(commentsKey, (current) => {
        if (!current?.pages[0]) {
          return { pages: [{ items: [optimistic], nextCursor: null, totalCount: 1 }], pageParams: [undefined] };
        }
        const known = current.pages.some((page) => page.items.some((item) => item.id === variables.id));
        if (known) return current;
        const pages = [...current.pages];
        pages[0] = { ...pages[0], items: [optimistic, ...pages[0].items], totalCount: pages[0].totalCount + 1 };
        return { ...current, pages };
      });
      setDraft("");
    },
    onSuccess: (comment) => {
      queryClient.setQueryData<InfiniteData<Page<Comment>, string | undefined>>(commentsKey, (current) => current ? {
        ...current,
        pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => item.id === comment.id ? comment : item) })),
      } : current);
      incrementTaskCommentCount(queryClient, projectId, taskId);
    },
    onError: (_error, variables) => {
      setDraft(variables.body);
      queryClient.setQueryData<InfiniteData<Page<Comment>, string | undefined>>(commentsKey, (current) => current ? {
        ...current,
        pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => item.id === variables.id ? { ...item, syncState: "failed" } : item) })),
      } : current);
    },
  });

  const send = () => {
    const body = draft.trim();
    if (!body || mutation.isPending) return;
    mutation.mutate({ body, id: crypto.randomUUID() });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {query.isLoading && <div className="space-y-5">{Array.from({ length: 3 }).map((_, index) => <div className="h-20 animate-pulse rounded-lg bg-slate-100" key={index} />)}</div>}
        {query.isError && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><AlertCircle className="mr-1.5 inline size-4" />Comments could not be loaded.</div>}
        {!query.isLoading && comments.length === 0 && <div className="py-8 text-center"><p className="text-sm font-medium">Start the conversation</p><p className="mt-1 text-xs text-[var(--text-muted)]">Comments synchronize with everyone viewing this project.</p></div>}
        {query.hasNextPage && <div className="mb-5 text-center"><Button variant="secondary" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load older comments"}</Button></div>}
        <div className="space-y-5">
          {comments.map((comment) => {
            const author = members.find((member) => member.id === comment.authorId) ?? members[0];
            return (
              <article key={comment.id} className={cn("group flex gap-3", comment.syncState === "failed" && "rounded-lg bg-rose-50 p-2 -m-2")}>
                <Avatar name={author?.displayName ?? "Unknown"} color={author?.color} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="text-xs font-semibold">{author?.displayName ?? "Unknown"}</span><time className="text-[11px] text-[var(--text-muted)]">{relativeTime(comment.createdAt)}</time></div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--text-secondary)]">{comment.body}</p>
                  {comment.syncState === "pending" && <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-indigo-600"><LoaderCircle className="size-3 animate-spin" />Sending</span>}
                  {comment.syncState === "failed" && <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-rose-700"><AlertCircle className="size-3" />Not sent — draft restored below</span>}
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <div className="border-t border-[var(--border)] bg-[var(--panel)] p-4">
        {mutation.isError && <div className="mb-2 flex items-center justify-between text-xs text-rose-700"><span>Could not send. Your draft is safe.</span><button className="inline-flex items-center gap-1 font-semibold" onClick={() => mutation.reset()}><RefreshCw className="size-3" />Dismiss</button></div>}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-2 shadow-sm focus-within:border-[var(--brand)] focus-within:ring-2 focus-within:ring-indigo-100">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") send(); }}
            placeholder="Write a comment…"
            aria-label="Comment"
            rows={3}
            className="min-h-16 border-0 p-1 shadow-none focus:ring-0"
          />
          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-[var(--text-muted)]">⌘ Enter to send{dataSource === "mock" ? " · type /fail to demo rollback" : ""}</span>
            <Button size="icon" className="size-8 rounded-lg" onClick={send} disabled={!draft.trim() || mutation.isPending} aria-label="Send comment"><ArrowUp className="size-4" /></Button>
          </div>
        </div>
      </div>
    </div>
  );
}
