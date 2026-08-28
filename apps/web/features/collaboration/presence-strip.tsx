"use client";

import { Eye } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import type { Member } from "@/lib/api";
import type { CollaboratorPresence } from "./use-project-presence";

export function PresenceStrip({ collaborators, members }: { collaborators: CollaboratorPresence[]; members: Member[] }) {
  if (!collaborators.length) return null;
  const memberById = new Map(members.map((member) => [member.id, member]));
  const visible = collaborators.slice(0, 3);
  return <div className="hidden items-center gap-2 sm:flex" aria-label={`${collaborators.length} other collaborator${collaborators.length === 1 ? "" : "s"} viewing this project`}>
    <div className="flex -space-x-2">{visible.map((collaborator) => { const member = memberById.get(collaborator.actorId); return <Avatar key={collaborator.sessionId} name={member?.displayName ?? "Collaborator"} color={member?.color} className="size-7 border-2 border-[var(--panel)]" />; })}</div>
    <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]"><Eye className="size-3.5" />{collaborators.length === 1 ? "1 here" : `${collaborators.length} here`}</span>
  </div>;
}
