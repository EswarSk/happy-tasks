"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { AlertCircle, ArrowUp, LoaderCircle, Plus, RefreshCw, Reply, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { incrementTaskCommentCount } from "@/features/tasks/query-cache";
import type { Comment, CommentReactionType, Member, Page } from "@/lib/api";
import { dataSource, workspaceApi } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { buildCommentTree } from "./comment-tree";
import type { CommentNode } from "./comment-tree";

interface CommentThreadProps {
  projectId: string;
  taskId: string;
  members: Member[];
}

interface ThreadCommentProps {
  comment: CommentNode;
  depth: number;
  membersById: Map<string, Member>;
  onReply: (comment: Comment) => void;
  onReact: (comment: Comment, type: CommentReactionType) => void;
  reactionPending?: boolean;
}

const reactionOptions: Array<{ type: CommentReactionType; label: string; symbol: string }> = [
  { type: "like", label: "Like", symbol: "♥" },
  { type: "celebrate", label: "Celebrate", symbol: "✦" },
  { type: "insightful", label: "Insightful", symbol: "◎" },
];

function ThreadComment({ comment, depth, membersById, onReply, onReact, reactionPending }: ThreadCommentProps) {
  const author = membersById.get(comment.authorId);
  const displayName = author?.displayName ?? "Unknown";

  return (
    <div className={cn(depth > 0 && depth <= 3 && "ml-5 border-l border-[var(--border)] pl-4")}>
      <article className={cn("group/comment flex gap-3 py-2", comment.syncState === "failed" && "rounded-lg bg-[var(--danger-bg)] p-2")}>
        <Avatar name={displayName} color={author?.color} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold">{displayName}</span>
            <time className="text-[11px] text-[var(--text-muted)]">{relativeTime(comment.createdAt)}</time>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--text-secondary)]">{comment.body}</p>
          <div className="mt-1 flex min-h-5 items-center gap-3">
            {comment.syncState === "pending" && <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]"><LoaderCircle className="size-3 animate-spin" />Sending</span>}
            {comment.syncState === "failed" && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--danger-text)]"><AlertCircle className="size-3" />Not sent — draft restored below</span>}
            {comment.syncState !== "failed" && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text)] focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                onClick={() => onReply(comment)}
                aria-label={`Reply to ${displayName}`}
              >
                <Reply className="size-3" />Reply
              </button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Comment reactions">
            {reactionOptions.map(({ type, label, symbol }) => {
              const reaction = comment.reactions?.find((item) => item.type === type);
              const active = reaction?.reacted ?? false;
              const count = reaction?.count ?? 0;
              return <button key={type} type="button" disabled={reactionPending} aria-pressed={active} aria-label={`${active ? "Remove" : "Add"} ${label} reaction`} onClick={() => onReact(comment, type)} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]", active ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]", !count && !active && "opacity-60")}>{symbol}<span>{count}</span></button>;
            })}
          </div>
        </div>
      </article>
      {comment.children.map((child) => (
        <ThreadComment key={child.id} comment={child} depth={depth + 1} membersById={membersById} onReply={onReply} onReact={onReact} reactionPending={reactionPending} />
      ))}
    </div>
  );
}

export function CommentThread({ projectId, taskId, members }: CommentThreadProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [replyToId, setReplyToId] = useState<string>();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const commentsKey = ["comments", projectId, taskId];
  const query = useInfiniteQuery({
    queryKey: commentsKey,
    queryFn: ({ pageParam }) => workspaceApi.listComments(projectId, taskId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const comments = useMemo(() => query.data ? query.data.pages.flatMap((page) => page.items).reverse() : [], [query.data]);
  const commentTree = useMemo(() => buildCommentTree(comments), [comments]);
  const membersById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const replyTarget = replyToId ? comments.find((comment) => comment.id === replyToId) : undefined;
  const replyAuthor = replyTarget ? membersById.get(replyTarget.authorId)?.displayName ?? "Unknown" : undefined;
  const reactionMutation = useMutation({
    mutationFn: ({ comment, type }: { comment: Comment; type: CommentReactionType }) => {
      const current = comment.reactions?.find((item) => item.type === type);
      return current?.reacted
        ? workspaceApi.removeCommentReaction(projectId, taskId, comment.id)
        : workspaceApi.setCommentReaction(projectId, taskId, comment.id, type);
    },
    onMutate: async ({ comment, type }) => {
      await queryClient.cancelQueries({ queryKey: commentsKey });
      const previous = queryClient.getQueryData<InfiniteData<Page<Comment>, string | undefined>>(commentsKey);
      const current = comment.reactions?.find((item) => item.type === type);
      const nextReacted = !(current?.reacted ?? false);
      queryClient.setQueryData<InfiniteData<Page<Comment>, string | undefined>>(commentsKey, (data) => data ? {
        ...data,
        pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => item.id === comment.id ? { ...item, reactions: reactionOptions.map(({ type: optionType }) => {
          const reaction = item.reactions?.find((entry) => entry.type === optionType);
          const wasActive = reaction?.reacted ?? false;
          const count = reaction?.count ?? 0;
          if (optionType === type) return { projectId, taskId, commentId: item.id, type: optionType, count: Math.max(0, count + (nextReacted ? 1 : -1)), reacted: nextReacted };
          return { projectId, taskId, commentId: item.id, type: optionType, count: Math.max(0, count - (wasActive ? 1 : 0)), reacted: false };
        }).filter((entry) => entry.count > 0 || entry.reacted) } : item) })),
      } : data);
      return { previous };
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: commentsKey }); },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(commentsKey, context.previous);
      toast.error(error instanceof Error ? error.message : "Reaction could not be saved");
    },
  });
  const mutation = useMutation({
    mutationFn: ({ body, id, parentId }: { body: string; id: string; parentId?: string }) => workspaceApi.createComment(projectId, taskId, body, id, parentId),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: commentsKey });
      const optimistic: Comment = {
        id: variables.id,
        projectId,
        taskId,
        ...(variables.parentId ? { parentId: variables.parentId } : {}),
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
      const pendingDraft = draft;
      const pendingReplyToId = replyToId;
      setDraft("");
      setReplyToId(undefined);
      return { draft: pendingDraft, replyToId: pendingReplyToId };
    },
    onSuccess: (comment) => {
      queryClient.setQueryData<InfiniteData<Page<Comment>, string | undefined>>(commentsKey, (current) => current ? {
        ...current,
        pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => item.id === comment.id ? comment : item) })),
      } : current);
      incrementTaskCommentCount(queryClient, projectId, taskId);
    },
    onError: (_error, variables, context) => {
      setDraft(context?.draft ?? variables.body);
      setReplyToId(context?.replyToId ?? variables.parentId);
      queryClient.setQueryData<InfiniteData<Page<Comment>, string | undefined>>(commentsKey, (current) => current ? {
        ...current,
        pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => item.id === variables.id ? { ...item, syncState: "failed" } : item) })),
      } : current);
    },
  });

  const send = () => {
    const body = draft.trim();
    if (!body || mutation.isPending) return;
    mutation.mutate({ body, id: crypto.randomUUID(), parentId: replyToId });
  };

  const startReply = (comment: Comment) => {
    setReplyToId(comment.id);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {query.isLoading && <div className="space-y-5">{Array.from({ length: 3 }).map((_, index) => <div className="h-20 animate-pulse rounded-lg bg-[var(--skeleton)]" key={index} />)}</div>}
        {query.isError && <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-sm text-[var(--danger-text)]"><AlertCircle className="mr-1.5 inline size-4" />Comments could not be loaded.</div>}
        {!query.isLoading && comments.length === 0 && <div className="py-8 text-center"><p className="text-sm font-medium">Start the conversation</p><p className="mt-1 text-xs text-[var(--text-muted)]">Comments synchronize with everyone viewing this project.</p></div>}
        {query.hasNextPage && <div className="mb-5 text-center"><Button variant="secondary" size="sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load older comments"}</Button></div>}
        <div className="space-y-2">
          {commentTree.map((comment) => <ThreadComment key={comment.id} comment={comment} depth={0} membersById={membersById} onReply={startReply} onReact={(nextComment, type) => reactionMutation.mutate({ comment: nextComment, type })} reactionPending={reactionMutation.isPending} />)}
        </div>
      </div>
      <div className="border-t border-[var(--border)] bg-[var(--panel)] p-4">
        {mutation.isError && <div className="mb-2 flex items-center justify-between text-xs text-[var(--danger-text)]"><span>Could not send. Your draft is safe.</span><button className="inline-flex items-center gap-1 font-semibold" onClick={() => mutation.reset()}><RefreshCw className="size-3" />Dismiss</button></div>}
        {replyTarget && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs">
            <span className="min-w-0 truncate text-[var(--text-secondary)]">Replying to <strong className="font-semibold text-[var(--text)]">{replyAuthor}</strong>: {replyTarget.body}</span>
            <button type="button" className="shrink-0 rounded-full p-1 text-[var(--text-muted)] hover:bg-[var(--secondary-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" onClick={() => setReplyToId(undefined)} aria-label="Cancel reply"><X className="size-3.5" /></button>
          </div>
        )}
        <div className="rounded-[28px] border border-[var(--border)] bg-[var(--muted)] p-3 transition-colors focus-within:border-[var(--text-secondary)] focus-within:ring-2 focus-within:ring-[var(--focus-soft)]">
          <Textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") send(); }}
            placeholder={replyTarget ? `Reply to ${replyAuthor}…` : "Write a comment…"}
            aria-label="Comment"
            rows={2}
            className="min-h-20 max-h-40 overflow-y-auto rounded-2xl border-0 bg-transparent px-3 py-2 text-sm leading-6 shadow-none focus:border-0 focus:bg-transparent focus:ring-0"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--text-muted)] shadow-sm transition-colors hover:bg-[var(--secondary-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              onClick={() => toast.info("Attachments are not available in this demo.")}
              aria-label="Add attachment"
              title="Add attachment"
            >
              <Plus className="size-5" />
            </button>
            <span className="sr-only">Press Command or Control and Enter to send{dataSource === "mock" ? ". Type slash fail to demo rollback." : "."}</span>
            <Button size="icon" className="size-9 rounded-full" onClick={send} disabled={!draft.trim() || mutation.isPending} aria-label="Send comment" title="Send comment"><ArrowUp className="size-4" /></Button>
          </div>
        </div>
      </div>
    </div>
  );
}
