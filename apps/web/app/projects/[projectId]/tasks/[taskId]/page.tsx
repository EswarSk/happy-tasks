import { WorkspaceShell } from "@/features/workspace/workspace-shell";

export default async function TaskPage({ params }: { params: Promise<{ projectId: string; taskId: string }> }) {
  const { projectId, taskId } = await params;
  return <WorkspaceShell projectId={projectId} selectedTaskId={taskId} />;
}
