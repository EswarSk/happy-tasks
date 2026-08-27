import type {
  Comment,
  Dependency,
  Member,
  Page,
  Project,
  Task,
  TaskFilters,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
  WorkspaceApi,
  WorkspaceBootstrap,
} from "./types";
import { WorkspaceApiError } from "./types";
import { newRequestId } from "@/lib/utils";

const demoActorId = "00000000-0000-7000-8000-000000000001";
const fallbackMembers: Member[] = [
  { id: demoActorId, displayName: "Avery Chen", email: "avery@example.com", color: "#5b5bd6" },
  { id: "00000000-0000-7000-8000-000000000002", displayName: "Maya Patel", email: "maya@example.com", color: "#0f9f6e" },
];
const memberColors = ["#5b5bd6", "#0f9f6e", "#d97706", "#db2777", "#0284c7"];

type ApiProject = Omit<Project, "taskCount" | "accent"> & { taskCount?: number; accent?: string };
type ApiTask = Omit<Task, "status" | "priority" | "key" | "blockingCount"> & {
  status: Uppercase<TaskStatus>;
  priority: Uppercase<TaskPriority>;
  key?: string;
  blockingCount?: number;
};
type ApiComment = Omit<Comment, "authorId"> & { authorId?: string; author?: { id: string } };

const normalizeProject = (project: ApiProject): Project => ({ ...project, taskCount: project.taskCount ?? 0, accent: project.accent ?? "#665cf6" });
const normalizeMember = (member: Omit<Member, "color"> & { color?: string }, index: number): Member => ({
  ...member,
  color: member.color ?? memberColors[index % memberColors.length],
});
const normalizeTask = (task: ApiTask): Task => ({
  ...task,
  key: task.key ?? `TSK-${task.id.replaceAll("-", "").slice(-6).toUpperCase()}`,
  status: task.status.toLowerCase() as TaskStatus,
  priority: task.priority.toLowerCase() as TaskPriority,
  blockingCount: task.blockingCount ?? 0,
});
const normalizeComment = (comment: ApiComment): Comment => ({ ...comment, authorId: comment.authorId ?? comment.author?.id ?? demoActorId });

export class HttpWorkspaceApi implements WorkspaceApi {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Actor-ID": demoActorId, "X-Request-ID": newRequestId(), ...init?.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new WorkspaceApiError(response.status, body.error ?? { code: "REQUEST_FAILED", message: "The request could not be completed." });
    return body as T;
  }

  async listProjects() {
    const page = await this.request<{ items: ApiProject[] }>("/v1/projects");
    return page.items.map(normalizeProject);
  }

  async createProject(name: string, description: string) {
    const project = await this.request<ApiProject>("/v1/projects", {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
      body: JSON.stringify({ id: crypto.randomUUID(), name, description }),
    });
    return normalizeProject(project);
  }

  async bootstrap(projectId: string): Promise<WorkspaceBootstrap> {
    try {
      const result = await this.request<{ project: ApiProject; members?: Member[]; streamCursor?: number }>(`/v1/projects/${projectId}/bootstrap`);
      return {
        project: normalizeProject(result.project),
        members: result.members?.length ? result.members.map(normalizeMember) : fallbackMembers,
        streamCursor: result.streamCursor ?? 0,
      };
    } catch (error) {
      if (!(error instanceof WorkspaceApiError) || error.status !== 404) throw error;
      const project = await this.request<ApiProject>(`/v1/projects/${projectId}`);
      return { project: normalizeProject(project), members: fallbackMembers, streamCursor: 0 };
    }
  }

  async listTasks(projectId: string, filters: TaskFilters): Promise<Page<Task>> {
    const params = new URLSearchParams();
    if (filters.cursor) params.set("cursor", filters.cursor);
    if (filters.limit) params.set("limit", String(filters.limit));
    if (filters.status && filters.status !== "all") params.set("status", filters.status.toUpperCase());
    if (filters.priority && filters.priority !== "all") params.set("priority", filters.priority.toUpperCase());
    if (filters.search) params.set("q", filters.search);
    const page = await this.request<{ items: ApiTask[]; nextCursor?: string }>(`/v1/projects/${projectId}/tasks?${params}`);
    const items = page.items.map(normalizeTask);
    return { items, nextCursor: page.nextCursor ?? null, totalCount: items.length };
  }

  async getTask(projectId: string, taskId: string) {
    return normalizeTask(await this.request<ApiTask>(`/v1/projects/${projectId}/tasks/${taskId}`));
  }

  async createTask(projectId: string, title: string) {
    const task = await this.request<ApiTask>(`/v1/projects/${projectId}/tasks`, {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
      body: JSON.stringify({ id: crypto.randomUUID(), title, status: "TODO", priority: "MEDIUM" }),
    });
    return normalizeTask(task);
  }

  async updateTask(projectId: string, taskId: string, input: UpdateTaskInput) {
    const { expectedVersion, status, priority, ...rest } = input;
    const body = { ...rest, ...(status ? { status: status.toUpperCase() } : {}), ...(priority ? { priority: priority.toUpperCase() } : {}) };
    const task = await this.request<ApiTask>(`/v1/projects/${projectId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": newRequestId(), "If-Match": `"${expectedVersion}"` },
      body: JSON.stringify(body),
    });
    return normalizeTask(task);
  }

  deleteTask(projectId: string, taskId: string, expectedVersion: number) {
    return this.request<{ id: string; deleted: true; version: number }>(`/v1/projects/${projectId}/tasks/${taskId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": newRequestId(), "If-Match": `"${expectedVersion}"` },
    });
  }

  async listComments(projectId: string, taskId: string, cursor?: string): Promise<Page<Comment>> {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const page = await this.request<{ items: ApiComment[]; nextCursor?: string }>(`/v1/projects/${projectId}/tasks/${taskId}/comments?${params}`);
    return { items: page.items.map(normalizeComment), nextCursor: page.nextCursor ?? null, totalCount: page.items.length };
  }

  async createComment(projectId: string, taskId: string, body: string, clientId: string) {
    const comment = await this.request<ApiComment>(`/v1/projects/${projectId}/tasks/${taskId}/comments`, {
      method: "POST",
      headers: { "Idempotency-Key": clientId },
      body: JSON.stringify({ id: clientId, body }),
    });
    return normalizeComment(comment);
  }

  addDependency(projectId: string, taskId: string, dependencyTaskId: string) {
    return this.request<Dependency>(`/v1/projects/${projectId}/tasks/${taskId}/dependencies`, {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
      body: JSON.stringify({ dependsOnTaskId: dependencyTaskId }),
    });
  }

  removeDependency(projectId: string, taskId: string, dependencyTaskId: string) {
    return this.request<Dependency>(`/v1/projects/${projectId}/tasks/${taskId}/dependencies/${dependencyTaskId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": newRequestId() },
    });
  }
}
