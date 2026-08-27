import { redirect } from "next/navigation";
import { demoProjectId } from "@/lib/api/mock-workspace-api";

export default function Home() {
  const projectId = process.env.NEXT_PUBLIC_DATA_SOURCE === "api"
    ? "01000000-0000-7000-8000-000000000001"
    : demoProjectId;
  redirect(`/projects/${projectId}`);
}
