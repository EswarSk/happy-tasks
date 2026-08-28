"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { Member } from "@/lib/api";
import { workspaceApi } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

export function NotificationBell({ projectId, members }: { projectId: string; members: Member[] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["notifications", projectId], queryFn: () => workspaceApi.listNotifications(projectId, true) });
  const markRead = useMutation({
    mutationFn: (notificationId: string) => workspaceApi.markNotificationRead(projectId, notificationId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["notifications", projectId] }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Notification could not be opened"),
  });
  const notifications = query.data?.items ?? [];
  const memberById = new Map(members.map((member) => [member.id, member]));

  return (
    <div className="relative">
      <Button variant="ghost" size="icon" aria-label={`${notifications.length} unread notifications`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Bell className="size-4" />
        {notifications.length > 0 && <span className="absolute top-1 right-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-[var(--brand)] px-1 text-[9px] font-bold text-[var(--primary-foreground)]">{notifications.length > 9 ? "9+" : notifications.length}</span>}
      </Button>
      {open && (
        <div className="absolute top-11 right-0 z-30 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-xl" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3"><div><p className="text-sm font-semibold">Notifications</p><p className="text-[11px] text-[var(--text-muted)]">Mentions from your project</p></div><span className="text-[11px] font-medium text-[var(--text-muted)]">{notifications.length} unread</span></div>
          <div className="max-h-80 overflow-y-auto p-2">
            {query.isLoading && <p className="px-3 py-8 text-center text-xs text-[var(--text-muted)]">Loading notifications…</p>}
            {!query.isLoading && notifications.length === 0 && <div className="px-3 py-8 text-center"><Check className="mx-auto size-5 text-[var(--success)]" /><p className="mt-2 text-sm font-medium">You’re all caught up</p><p className="mt-1 text-xs text-[var(--text-muted)]">Mention a teammate with @name in a comment.</p></div>}
            {notifications.map((notification) => {
              const actor = memberById.get(notification.actorId);
              return <button key={notification.id} type="button" className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" onClick={() => { markRead.mutate(notification.id); setOpen(false); router.push(`/projects/${projectId}/tasks/${notification.taskId}`); }}>
                <Avatar name={actor?.displayName ?? "Collaborator"} color={actor?.color} className="mt-0.5" />
                <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 text-sm font-medium"><MessageCircle className="size-3.5 text-[var(--brand)]" />{actor?.displayName ?? "A collaborator"}</span><span className="mt-1 block text-xs text-[var(--text-secondary)]">{notification.body}</span><span className={cn("mt-1 block text-[11px]", notification.readAt ? "text-[var(--text-muted)]" : "text-[var(--brand)]")}>{relativeTime(notification.createdAt)}</span></span>
              </button>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
