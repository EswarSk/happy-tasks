import { AgenticWorkflowPage } from "@/features/tasks/agentic-view";

export default async function AgenticPage({ params }: { params: Promise<{ projectId: string; taskId: string }> }) {
  const { projectId, taskId } = await params;
  return <AgenticWorkflowPage projectId={projectId} taskId={taskId} />;
}
