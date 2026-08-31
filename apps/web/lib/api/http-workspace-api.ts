import type {
  AgentRun,
  AssignmentHistoryItem,
  ActivityItem,
  Attachment,
  AuthUser,
  Comment,
  CommentReaction,
  CommentReactionType,
  Dependency,
  Member,
  MemberFilters,
  Notification,
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

export const demoActorId = "00000000-0000-7000-8000-000000000001";
const fallbackMembers: Member[] = [
  { id: demoActorId, displayName: "Maya Chen", email: "maya@example.test", color: "#18181b" },
  { id: "00000000-0000-7000-8000-000000000002", displayName: "Avery Chen", email: "avery@example.test", color: "#52525b" },
];
const memberColors = ["#18181b", "#3f3f46", "#52525b", "#71717a", "#27272a"];

type ApiProject = Omit<Project, "taskCount" | "accent"> & { taskCount?: number; accent?: string };
type ApiTask = Omit<Task, "status" | "priority" | "key" | "blockingCount"> & {
  status: Uppercase<TaskStatus>;
  priority: Uppercase<TaskPriority>;
  key?: string;
  blockingCount?: number;
};
type ApiComment = Omit<Comment, "authorId" | "reactions"> & { authorId?: string; author?: { id: string }; reactions?: Array<Omit<CommentReaction, "type"> & { type: Uppercase<CommentReactionType> }> };
type ApiUser = {
  id: string;
  displayName: string;
  email?: string | null;
  status?: Member["userStatus"];
  avatarUrl?: string | null;
  createdAt?: string;
};
type ApiMembership = {
  id: string;
  projectId: string;
  user: ApiUser;
  role: Member["role"];
  status: Member["membershipStatus"];
};
type LegacyApiMember = Omit<Member, "color"> & { color?: string };

const normalizeProject = (project: ApiProject): Project => ({ ...project, taskCount: project.taskCount ?? 0, accent: project.accent ?? "#18181b" });
const normalizeMember = (member: LegacyApiMember | ApiMembership, index: number): Member => {
  if ("user" in member) {
    return {
      id: member.user.id,
      membershipId: member.id,
      displayName: member.user.displayName,
      email: member.user.email ?? "",
      color: memberColors[index % memberColors.length],
      role: member.role,
      membershipStatus: member.status,
      userStatus: member.user.status,
    };
  }
  return { ...member, color: member.color ?? memberColors[index % memberColors.length] };
};
const normalizeTask = (task: ApiTask): Task => ({
  ...task,
  key: task.key ?? `TSK-${task.id.replaceAll("-", "").slice(-6).toUpperCase()}`,
  status: task.status.toLowerCase() as TaskStatus,
  priority: task.priority.toLowerCase() as TaskPriority,
  blockingCount: task.blockingCount ?? 0,
});
const normalizeComment = (comment: ApiComment): Comment => ({
  ...comment,
  authorId: comment.authorId ?? comment.author?.id ?? demoActorId,
  reactions: comment.reactions?.map((reaction) => ({ ...reaction, type: reaction.type.toLowerCase() as CommentReactionType })),
});

export class HttpWorkspaceApi implements WorkspaceApi {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const formData = typeof FormData !== "undefined" && init?.body instanceof FormData;
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { ...(formData ? {} : { "Content-Type": "application/json" }), "X-Request-ID": newRequestId(), ...init?.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new WorkspaceApiError(response.status, body.error ?? { code: "REQUEST_FAILED", message: "The request could not be completed." });
    return body as T;
  }

  async login(email: string, password: string) {
    const result = await this.request<{ user: AuthUser }>("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    return result.user;
  }

  async register(displayName: string, email: string, password: string) {
    const result = await this.request<{ user: AuthUser }>("/v1/auth/register", { method: "POST", body: JSON.stringify({ displayName, email, password }) });
    return result.user;
  }

  async logout() {
    await this.request<void>("/v1/auth/logout", { method: "POST" });
  }

  async me() {
    const result = await this.request<{ user: AuthUser | null }>("/v1/auth/me");
    return result.user;
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
      const result = await this.request<{ project: ApiProject; members?: LegacyApiMember[]; streamCursor?: number }>(`/v1/projects/${projectId}/bootstrap`);
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

  async listMembers(projectId: string, filters: MemberFilters = {}): Promise<Page<Member>> {
    const params = new URLSearchParams();
    if (filters.search) params.set("q", filters.search);
    if (filters.status) params.set("status", filters.status);
    if (filters.role) params.set("role", filters.role);
    if (filters.cursor) params.set("cursor", filters.cursor);
    params.set("limit", String(filters.limit ?? 50));
    const page = await this.request<{ items: ApiMembership[]; nextCursor?: string }>(`/v1/projects/${projectId}/members?${params}`);
    const items = page.items.map(normalizeMember);
    return { items, nextCursor: page.nextCursor ?? null, totalCount: items.length };
  }

  async listMemberCandidates(projectId: string, filters: Pick<MemberFilters, "search" | "cursor" | "limit"> = {}): Promise<Page<Member>> {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 25) });
    if (filters.search) params.set("q", filters.search);
    if (filters.cursor) params.set("cursor", filters.cursor);
    const page = await this.request<{ items: ApiUser[]; nextCursor?: string }>(`/v1/projects/${projectId}/members/candidates?${params}`);
    const items = page.items.map((user, index) => ({ id: user.id, displayName: user.displayName, email: user.email ?? "", color: memberColors[index % memberColors.length], userStatus: user.status }));
    return { items, nextCursor: page.nextCursor ?? null, totalCount: items.length };
  }

  async addProjectMember(projectId: string, userId: string): Promise<Member> {
    const membership = await this.request<ApiMembership>(`/v1/projects/${projectId}/members`, {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
      body: JSON.stringify({ userId, role: "MEMBER", status: "ACTIVE" }),
    });
    return normalizeMember(membership, 0);
  }

  async listTasks(projectId: string, filters: TaskFilters): Promise<Page<Task>> {
    const params = new URLSearchParams();
    if (filters.cursor) params.set("cursor", filters.cursor);
    if (filters.limit) params.set("limit", String(filters.limit));
    if (filters.status && filters.status !== "all") params.set("status", filters.status.toUpperCase());
    if (filters.priority && filters.priority !== "all") params.set("priority", filters.priority.toUpperCase());
    if (filters.assigneeId) params.set("assignee", filters.assigneeId);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.search) params.set("q", filters.search);
    const page = await this.request<{ items: ApiTask[]; nextCursor?: string }>(`/v1/projects/${projectId}/tasks?${params}`);
    const items = page.items.map(normalizeTask);
    return { items, nextCursor: page.nextCursor ?? null, totalCount: items.length };
  }

  async getTask(projectId: string, taskId: string) {
    return normalizeTask(await this.request<ApiTask>(`/v1/projects/${projectId}/tasks/${taskId}`));
  }

  async getLatestAgentRun(projectId: string, taskId: string): Promise<AgentRun | null> {
    try {
      return await this.request<AgentRun>(`/v1/projects/${projectId}/tasks/${taskId}/agent-runs/latest`);
    } catch (error) {
      if (error instanceof WorkspaceApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createTask(projectId: string, title: string) {
    return this.createTaskWithIdentity(projectId, title, crypto.randomUUID(), newRequestId());
  }

  protected async createTaskWithIdentity(projectId: string, title: string, id: string, idempotencyKey: string) {
    const task = await this.request<ApiTask>(`/v1/projects/${projectId}/tasks`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ id, title, status: "TODO", priority: "MEDIUM" }),
    });
    return normalizeTask(task);
  }

  async updateTask(projectId: string, taskId: string, input: UpdateTaskInput) {
    return this.updateTaskWithIdentity(projectId, taskId, input, newRequestId());
  }

  protected async updateTaskWithIdentity(projectId: string, taskId: string, input: UpdateTaskInput, idempotencyKey: string) {
    const { expectedVersion, status, priority, ...rest } = input;
    const body = { ...rest, ...(status ? { status: status.toUpperCase() } : {}), ...(priority ? { priority: priority.toUpperCase() } : {}) };
    const task = await this.request<ApiTask>(`/v1/projects/${projectId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": idempotencyKey, "If-Match": `"${expectedVersion}"` },
      body: JSON.stringify(body),
    });
    return normalizeTask(task);
  }

  async undoTask(projectId: string, taskId: string) {
    const task = await this.request<ApiTask>(`/v1/projects/${projectId}/tasks/${taskId}/undo`, {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
    });
    return normalizeTask(task);
  }

  async redoTask(projectId: string, taskId: string) {
    const task = await this.request<ApiTask>(`/v1/projects/${projectId}/tasks/${taskId}/redo`, {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
    });
    return normalizeTask(task);
  }

  deleteTask(projectId: string, taskId: string, expectedVersion: number) {
    return this.deleteTaskWithIdentity(projectId, taskId, expectedVersion, newRequestId());
  }

  protected deleteTaskWithIdentity(projectId: string, taskId: string, expectedVersion: number, idempotencyKey: string) {
    return this.request<{ id: string; deleted: true; version: number }>(`/v1/projects/${projectId}/tasks/${taskId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey, "If-Match": `"${expectedVersion}"` },
    });
  }

  async listComments(projectId: string, taskId: string, cursor?: string): Promise<Page<Comment>> {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const page = await this.request<{ items: ApiComment[]; nextCursor?: string }>(`/v1/projects/${projectId}/tasks/${taskId}/comments?${params}`);
    return { items: page.items.map(normalizeComment), nextCursor: page.nextCursor ?? null, totalCount: page.items.length };
  }

  async createComment(projectId: string, taskId: string, body: string, clientId: string, parentId?: string) {
    const comment = await this.request<ApiComment>(`/v1/projects/${projectId}/tasks/${taskId}/comments`, {
      method: "POST",
      headers: { "Idempotency-Key": clientId },
      body: JSON.stringify({ id: clientId, body, ...(parentId ? { parentId } : {}) }),
    });
    return normalizeComment(comment);
  }

  async setCommentReaction(projectId: string, taskId: string, commentId: string, type: CommentReactionType) {
    return this.request<CommentReaction>(`/v1/projects/${projectId}/tasks/${taskId}/comments/${commentId}/reaction`, {
      method: "PUT",
      headers: { "Idempotency-Key": newRequestId() },
      body: JSON.stringify({ type: type.toUpperCase() }),
    });
  }

  async removeCommentReaction(projectId: string, taskId: string, commentId: string) {
    return this.request<CommentReaction>(`/v1/projects/${projectId}/tasks/${taskId}/comments/${commentId}/reaction`, {
      method: "DELETE",
      headers: { "Idempotency-Key": newRequestId() },
    });
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

  async listAssignmentHistory(projectId: string, taskId: string, cursor?: string): Promise<Page<AssignmentHistoryItem>> {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const page = await this.request<{ items: AssignmentHistoryItem[]; nextCursor?: string }>(`/v1/projects/${projectId}/tasks/${taskId}/assignment-history?${params}`);
    return { items: page.items, nextCursor: page.nextCursor ?? null, totalCount: page.items.length };
  }

  async listActivity(projectId: string, after?: string): Promise<Page<ActivityItem>> {
    const params = new URLSearchParams({ limit: "50" });
    if (after) params.set("after", after);
    const page = await this.request<{ items: ActivityItem[]; nextCursor?: string }>(`/v1/projects/${projectId}/activity?${params}`);
    return { items: page.items, nextCursor: page.nextCursor ?? null, totalCount: page.items.length };
  }

  async listNotifications(projectId: string, unreadOnly = true, cursor?: string): Promise<Page<Notification>> {
    const params = new URLSearchParams({ limit: "50", unread: String(unreadOnly) });
    if (cursor) params.set("cursor", cursor);
    const page = await this.request<{ items: Notification[]; nextCursor?: string }>(`/v1/projects/${projectId}/notifications?${params}`);
    return { items: page.items, nextCursor: page.nextCursor ?? null, totalCount: page.items.length };
  }

  async markNotificationRead(projectId: string, notificationId: string) {
    return this.request<Notification>(`/v1/projects/${projectId}/notifications/${notificationId}/read`, {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
    });
  }

  async listAttachments(projectId: string, taskId: string): Promise<Attachment[]> {
    const result = await this.request<{ items: Attachment[] }>(`/v1/projects/${projectId}/tasks/${taskId}/attachments`);
    return result.items;
  }

  async uploadAttachment(projectId: string, taskId: string, file: File): Promise<Attachment> {
    const body = new FormData();
    body.set("id", crypto.randomUUID());
    body.set("file", file);
    return this.request<Attachment>(`/v1/projects/${projectId}/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { "Idempotency-Key": newRequestId() },
      body,
    });
  }

  async deleteAttachment(projectId: string, taskId: string, attachmentId: string): Promise<Attachment> {
    return this.request<Attachment>(`/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": newRequestId() },
    });
  }

  attachmentUrl(projectId: string, taskId: string, attachmentId: string) {
    return `${this.baseUrl}/v1/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}`;
  }
}
