"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Bot, Check, Circle, GitBranch, LoaderCircle, Workflow } from "lucide-react";
import Link from "next/link";
import type { AgentRunNode, AgentRunNodeStatus } from "@/lib/api";
import { workspaceApi } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";

const nodeWidth = 230;
const nodeHeight = 112;
const canvasPadding = 80;

const statusLabel: Record<AgentRunNodeStatus, string> = {
  PENDING: "Pending", READY: "Ready", RUNNING: "Running", WAITING: "Waiting",
  SUCCEEDED: "Succeeded", FAILED: "Failed", SKIPPED: "Skipped", CANCELLED: "Cancelled",
};

export function edgePath(source: Pick<AgentRunNode, "positionX" | "positionY">, target: Pick<AgentRunNode, "positionX" | "positionY">) {
  const startX = source.positionX + canvasPadding + nodeWidth;
  const startY = source.positionY + canvasPadding + nodeHeight / 2;
  const endX = target.positionX + canvasPadding;
  const endY = target.positionY + canvasPadding + nodeHeight / 2;
  const bend = Math.max((endX - startX) / 2, 40);
  return `M${startX} ${startY} C${startX + bend} ${startY} ${endX - bend} ${endY} ${endX} ${endY}`;
}

function StatusIcon({ status }: { status: AgentRunNodeStatus }) {
  if (status === "SUCCEEDED") return <Check className="size-3" />;
  if (status === "RUNNING") return <LoaderCircle className="size-3 animate-spin" />;
  if (status === "FAILED" || status === "CANCELLED") return <AlertTriangle className="size-3" />;
  return <Circle className="size-3" />;
}

function AgentNodeCard({ node }: { node: AgentRunNode }) {
  return (
    <article
      aria-label={`${node.agentName}: ${statusLabel[node.status]}`}
      aria-current={node.status === "RUNNING" ? "step" : undefined}
      className={cn(
        "absolute z-10 w-[230px] rounded-lg border bg-[var(--panel)] shadow-md shadow-[var(--shadow)]",
        node.status === "RUNNING" && "border-[var(--brand)] ring-4 ring-[var(--focus-soft)]",
        node.status === "FAILED" && "border-[var(--danger-border)]",
        (node.status === "PENDING" || node.status === "READY") && "border-dashed opacity-75",
      )}
      style={{ left: node.positionX + canvasPadding, top: node.positionY + canvasPadding }}
    >
      <span aria-hidden="true" className="absolute top-1/2 -left-[5px] size-2.5 -translate-y-1/2 rounded-full border-2 border-[var(--panel)] bg-[var(--text-muted)]" />
      <span aria-hidden="true" className="absolute top-1/2 -right-[5px] size-2.5 -translate-y-1/2 rounded-full border-2 border-[var(--panel)] bg-[var(--text-muted)]" />
      <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] p-3">
        <div className={cn("grid size-9 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)]", node.status === "RUNNING" && "bg-[var(--brand)] text-[var(--primary-foreground)]")}><Bot className="size-4.5" /></div>
        <div className="min-w-0"><h2 className="truncate text-sm font-semibold">{node.label}</h2><p className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]">{node.agentName} · {node.nodeType}</p></div>
      </div>
      <div className="flex items-start gap-2 p-3"><span className={cn("mt-0.5 inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--text-muted)]", node.status === "FAILED" && "text-[var(--danger-text)]")}><StatusIcon status={node.status} />{statusLabel[node.status]}</span><p className="line-clamp-2 flex-1 text-right text-[10px] leading-4 text-[var(--text-muted)]">Attempt {node.attempt}</p></div>
    </article>
  );
}

export function AgenticWorkflowPage({ projectId, taskId }: { projectId: string; taskId: string }) {
  const taskQuery = useQuery({ queryKey: ["task", projectId, taskId], queryFn: () => workspaceApi.getTask(projectId, taskId) });
  const runQuery = useQuery({
    queryKey: ["agent-run", projectId, taskId],
    queryFn: () => workspaceApi.getLatestAgentRun(projectId, taskId),
    refetchInterval: (query) => query.state.data && ["PENDING", "RUNNING", "WAITING"].includes(query.state.data.status) ? 3_000 : false,
  });
  const task = taskQuery.data;
  const run = runQuery.data;

  if (taskQuery.isLoading || runQuery.isLoading) return <main className="grid h-dvh place-items-center bg-[var(--surface-muted)]"><div className="text-center"><LoaderCircle className="mx-auto size-6 animate-spin text-[var(--text-muted)]" /><p className="mt-3 text-sm text-[var(--text-muted)]">Loading agent workflow…</p></div></main>;
  if (taskQuery.isError || runQuery.isError || !task) return <main className="grid h-dvh place-items-center bg-[var(--surface-muted)]"><div className="text-center"><AlertTriangle className="mx-auto size-6 text-[var(--danger)]" /><p className="mt-3 text-sm">Agent workflow could not be loaded.</p></div></main>;

  if (!run) return <main className="grid h-dvh place-items-center bg-[var(--surface-muted)] p-6"><div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-8 text-center shadow-sm"><Workflow className="mx-auto size-7 text-[var(--text-muted)]" /><h1 className="mt-4 font-semibold">No agent run yet</h1><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">No orchestrator has reported an execution for {task.key}. This view appears when a run is linked to the task.</p><Link href={`/projects/${projectId}/tasks/${taskId}`} className="mt-5 inline-flex min-h-9 items-center gap-2 rounded-full border border-[var(--border)] px-4 text-xs font-medium hover:bg-[var(--hover)]"><ArrowLeft className="size-3.5" />Back to task</Link></div></main>;

  const nodeById = new Map(run.nodes.map((node) => [node.id, node]));
  const completed = run.nodes.filter((node) => ["SUCCEEDED", "SKIPPED"].includes(node.status)).length;
  const canvasWidth = Math.max(1_100, ...run.nodes.map((node) => node.positionX + nodeWidth + canvasPadding * 2));
  const canvasHeight = Math.max(600, ...run.nodes.map((node) => node.positionY + nodeHeight + canvasPadding * 2));

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--surface-muted)]">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-[var(--border)] bg-[var(--panel)] px-4 shadow-sm sm:px-6">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--brand)] text-[var(--primary-foreground)]"><Workflow className="size-4.5" /></div>
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-[10px] font-semibold tracking-wide text-[var(--text-muted)] uppercase"><span>{task.key}</span><span>·</span><span>{run.orchestrator}</span><span>·</span><span>v{run.definitionVersion}</span></div><h1 className="truncate text-sm font-semibold sm:text-base">{run.workflowName}</h1></div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1.5 text-xs font-semibold"><span className={cn("size-1.5 rounded-full bg-[var(--text-muted)]", run.status === "RUNNING" && "pulse-dot bg-[var(--brand)]", run.status === "FAILED" && "bg-[var(--danger)]")} />{run.status.toLowerCase()}</span>
        <Link href={`/projects/${projectId}/tasks/${taskId}`} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 text-xs font-medium hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><ArrowLeft className="size-3.5" /><span className="hidden sm:inline">Back to task</span></Link>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="agent-workflow-canvas relative min-h-[520px] min-w-0 flex-1 overflow-auto" aria-label="Agent workflow canvas">
          <div className="sticky top-4 left-4 z-20 ml-4 inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 shadow-sm"><GitBranch className="size-3.5 text-[var(--text-muted)]" /><span className="text-xs font-medium">{run.nodes.length} runtime nodes</span><span className="text-[10px] text-[var(--text-muted)]">{completed} complete</span></div>
          <div className="relative -mt-9" style={{ width: canvasWidth, height: canvasHeight }}>
            <svg aria-hidden="true" className="absolute inset-0 size-full" width={canvasWidth} height={canvasHeight}>
              <g stroke="var(--text-muted)" strokeWidth="2" fill="none">
                {run.edges.map((edge) => {
                  const source = nodeById.get(edge.sourceNodeId);
                  const target = nodeById.get(edge.targetNodeId);
                  return source && target ? <path key={`${edge.sourceNodeId}:${edge.targetNodeId}`} d={edgePath(source, target)} /> : null;
                })}
              </g>
            </svg>
            {run.nodes.map((node) => <AgentNodeCard key={node.id} node={node} />)}
          </div>
        </section>

        <aside className="flex max-h-[44%] shrink-0 flex-col overflow-y-auto border-t border-[var(--border)] bg-[var(--panel)] lg:max-h-none lg:w-[350px] lg:border-t-0 lg:border-l" aria-label="Execution details">
          <div className="border-b border-[var(--border)] p-5"><p className="section-label">Execution</p><div className="mt-2 flex items-center justify-between"><h2 className="truncate font-semibold">{run.externalRunId}</h2><span className="ml-2 shrink-0 font-mono text-[10px] text-[var(--text-muted)]">{run.definitionId}</span></div><div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]" role="progressbar" aria-label="Agent run progress" aria-valuemin={0} aria-valuemax={run.nodes.length} aria-valuenow={completed}><div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${run.nodes.length ? completed / run.nodes.length * 100 : 0}%` }} /></div><p className="mt-2 text-[11px] text-[var(--text-muted)]">Started {run.startedAt ? relativeTime(run.startedAt) : "not yet"} · updated {relativeTime(run.updatedAt)}</p></div>
          <div className="p-5"><p className="section-label">Audit log</p><div className="mt-4 space-y-4">
            {[...run.events].reverse().map((event) => { const node = event.nodeId ? nodeById.get(event.nodeId) : undefined; return <div key={event.externalEventId} className="relative flex gap-3 text-xs before:absolute before:top-5 before:bottom-[-16px] before:left-[7px] before:w-px before:bg-[var(--border)] last:before:hidden"><span className={cn("relative z-10 mt-1.5 size-3.5 shrink-0 rounded-full border-2 border-[var(--panel)] bg-[var(--text-muted)]", event.eventType.endsWith("started") && "pulse-dot bg-[var(--brand)]", event.eventType.includes("failed") && "bg-[var(--danger)]")} /><div className="min-w-0"><p className="truncate font-semibold">{node?.agentName ?? run.workflowName}</p><p className="mt-1 leading-5 text-[var(--text-secondary)]">{event.message}</p><p className="mt-1 font-mono text-[10px] text-[var(--text-muted)]">#{event.sequence} · {relativeTime(event.occurredAt)}</p></div></div>; })}
            {!run.events.length && <p className="text-xs leading-5 text-[var(--text-muted)]">No execution events have been reported.</p>}
          </div></div>
        </aside>
      </div>
    </main>
  );
}
