"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Check, Search, UserPlus, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Member } from "@/lib/api";
import { workspaceApi } from "@/lib/api";

interface AssigneePickerProps {
  projectId: string;
  assignedIds: string[];
  memberPreview: Member[];
  disabled?: boolean;
  onChange: (assigneeIds: string[]) => void;
}

export function AssigneePicker({ projectId, assignedIds, memberPreview, disabled, onChange }: AssigneePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const membersQuery = useInfiniteQuery({
    queryKey: ["members", projectId, "ACTIVE", deferredSearch],
    queryFn: ({ pageParam }) => workspaceApi.listMembers(projectId, { search: deferredSearch, status: "ACTIVE", cursor: pageParam, limit: 25 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
  });

  const searchableMembers = useMemo(() => membersQuery.data?.pages.flatMap((page) => page.items) ?? [], [membersQuery.data]);
  const memberById = useMemo(() => new Map([...memberPreview, ...searchableMembers].map((member) => [member.id, member])), [memberPreview, searchableMembers]);
  const assignedMembers = assignedIds.map((id) => memberById.get(id) ?? { id, displayName: "Former member", email: "", color: "#737373" });
  const toggle = (userId: string) => onChange(assignedIds.includes(userId) ? assignedIds.filter((id) => id !== userId) : [...assignedIds, userId]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {assignedMembers.map((member) => (
          <span key={member.id} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-raised)] py-1 pr-1 pl-1 text-xs text-[var(--text-secondary)]">
            <Avatar name={member.displayName} color={member.color} className="size-5 border-0" />
            <span>{member.displayName.split(" ")[0]}</span>
            <button type="button" aria-label={`Unassign ${member.displayName}`} disabled={disabled} onClick={() => toggle(member.id)} className="grid size-5 place-items-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-bg)] hover:text-[var(--danger-text)] focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-50">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button type="button" variant="secondary" size="sm" className="min-h-7 px-2.5" disabled={disabled} onClick={() => setOpen(true)}>
          <UserPlus className="size-3.5" />{assignedIds.length ? "Assign another" : "Assign people"}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen} title="Assign people" description="Search active project members. Existing assignees can be removed here or directly from the task.">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-10" placeholder="Search by name or email…" autoFocus />
        </div>
        <div className="mt-3 max-h-72 space-y-1 overflow-y-auto" role="listbox" aria-label="Active project members" aria-multiselectable="true">
          {membersQuery.isLoading && <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">Loading members…</p>}
          {membersQuery.isError && <div className="px-3 py-6 text-center"><p className="text-sm text-[var(--danger-text)]">Members could not be loaded.</p><Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => membersQuery.refetch()}>Try again</Button></div>}
          {!membersQuery.isLoading && !membersQuery.isError && !searchableMembers.length && <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">No active members match this search.</p>}
          {searchableMembers.map((member) => {
            const selected = assignedIds.includes(member.id);
            return (
              <button key={member.membershipId ?? member.id} type="button" role="option" aria-selected={selected} disabled={disabled} onClick={() => toggle(member.id)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-50">
                <Avatar name={member.displayName} color={member.color} className="size-8" />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{member.displayName}</span><span className="block truncate text-xs text-[var(--text-muted)]">{member.email || member.role?.toLowerCase()}</span></span>
                <span className={`grid size-5 place-items-center rounded-full border ${selected ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--primary-foreground)]" : "border-[var(--border)] text-transparent"}`}><Check className="size-3" /></span>
              </button>
            );
          })}
          {membersQuery.hasNextPage && <Button type="button" variant="ghost" size="sm" className="w-full" disabled={membersQuery.isFetchingNextPage} onClick={() => membersQuery.fetchNextPage()}>{membersQuery.isFetchingNextPage ? "Loading…" : "Load more"}</Button>}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-[var(--border-subtle)] pt-4"><span className="text-xs text-[var(--text-muted)]">{assignedIds.length} assigned</span><Button type="button" size="sm" onClick={() => setOpen(false)}>Done</Button></div>
      </Dialog>
    </>
  );
}
