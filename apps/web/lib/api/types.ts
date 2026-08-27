export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type ConnectionState = "live" | "reconnecting" | "offline";
export type SyncState = "synced" | "pending" | "failed" | "conflict";
export type UserStatus = "ACTIVE" | "SUSPENDED" | "DELETED";
export type MemberRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export type MembershipStatus = "ACTIVE" | "INVITED" | "SUSPENDED" | "REMOVED";

export interface Project {
  id: string;
  name: string;
  description: string;
  taskCount: number;
  updatedAt: string;
  accent: string;
  version: number;
}

export interface Member {
  id: string;
  membershipId?: string;
  displayName: string;
  email: string;
  color: string;
  role?: MemberRole;
  membershipStatus?: MembershipStatus;
  userStatus?: UserStatus;
}

export interface Task {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeIds: string[];
  tags: string[];
  dependencyIds: string[];
  blockingCount: number;
  commentCount: number;
  customFields: Record<string, string>;
  updatedAt: string;
  version: number;
  syncState?: SyncState;
}

export interface Comment {
  id: string;
  projectId: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
  version: number;
  syncState?: SyncState;
}

export interface ActivityItem {
  id: string;
  actorId: string;
  description: string;
  occurredAt: string;
}

export interface AssignmentHistoryItem {
  id: string;
  projectId: string;
  taskId: string;
  userId: string;
  membershipId: string;
  operation: "ASSIGNED" | "UNASSIGNED";
  actorId: string;
  requestId: string;
  occurredAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  totalCount: number;
}

export interface TaskFilters {
  search?: string;
  status?: TaskStatus | "all";
  priority?: TaskPriority | "all";
  cursor?: string;
  limit?: number;
}

export interface MemberFilters {
  search?: string;
  status?: MembershipStatus;
  role?: MemberRole;
  cursor?: string;
  limit?: number;
}

export interface WorkspaceBootstrap {
  project: Project;
  members: Member[];
  streamCursor: number;
}

export interface Dependency {
  taskId: string;
  dependsOnTaskId: string;
  deleted?: boolean;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeIds?: string[];
  tags?: string[];
  expectedVersion: number;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class WorkspaceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiError: ApiErrorShape,
  ) {
    super(apiError.message);
    this.name = "WorkspaceApiError";
  }
}

export interface WorkspaceApi {
  listProjects(): Promise<Project[]>;
  createProject(name: string, description: string): Promise<Project>;
  bootstrap(projectId: string): Promise<WorkspaceBootstrap>;
  listMembers(projectId: string, filters?: MemberFilters): Promise<Page<Member>>;
  listTasks(projectId: string, filters: TaskFilters): Promise<Page<Task>>;
  getTask(projectId: string, taskId: string): Promise<Task>;
  createTask(projectId: string, title: string): Promise<Task>;
  updateTask(projectId: string, taskId: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(projectId: string, taskId: string, expectedVersion: number): Promise<{ id: string; deleted: true; version: number }>;
  listComments(projectId: string, taskId: string, cursor?: string): Promise<Page<Comment>>;
  createComment(projectId: string, taskId: string, body: string, clientId: string): Promise<Comment>;
  addDependency(projectId: string, taskId: string, dependencyTaskId: string): Promise<Dependency>;
  removeDependency(projectId: string, taskId: string, dependencyTaskId: string): Promise<Dependency>;
  listAssignmentHistory(projectId: string, taskId: string, cursor?: string): Promise<Page<AssignmentHistoryItem>>;
}
