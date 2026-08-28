import { WorkspaceShell } from "@/features/workspace/workspace-shell";

export default async function ActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <WorkspaceShell projectId={projectId} showActivity />;
}
