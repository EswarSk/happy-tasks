export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type ConnectionState = "live" | "reconnecting" | "offline";
export type SyncState = "synced" | "pending" | "failed" | "conflict";
export type UserStatus = "ACTIVE" | "SUSPENDED" | "DELETED";
export type MemberRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export type MembershipStatus = "ACTIVE" | "INVITED" | "SUSPENDED" | "REMOVED";
export type CommentReactionType = "like" | "celebrate" | "insightful";

export interface Project {
  id: string;
  organizationId?: string;
  name: string;
  description: string;
  taskCount: number;
  updatedAt: string;
  accent: string;
  version: number;
}

export interface Attachment {
  id: string;
  projectId: string;
  taskId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  uploadedBy: string;
  createdAt: string;
}

export interface AuthUser {
  id: string;
  displayName: string;
  email: string;
  status?: UserStatus;
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
  parentId?: string;
  authorId: string;
  body: string;
  createdAt: string;
  version: number;
  syncState?: SyncState;
  reactions?: CommentReaction[];
}

export interface CommentReaction {
  projectId: string;
  taskId: string;
  commentId: string;
  type: CommentReactionType;
  count: number;
  reacted: boolean;
}

export interface ActivityItem {
  id: string;
  projectId: string;
  sequence: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actorId: string;
  description: string;
  occurredAt: string;
}

export type AgentRunStatus = "PENDING" | "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type AgentRunNodeStatus = "PENDING" | "READY" | "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED";

export interface AgentRun {
  id: string;
  projectId: string;
  taskId: string;
  orchestrator: string;
  externalRunId: string;
  workflowName: string;
  definitionId: string;
  definitionVersion: string;
  status: AgentRunStatus;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  nodes: AgentRunNode[];
  edges: AgentRunEdge[];
  events: AgentRunEvent[];
}

export interface AgentRunNode {
  id: string;
  externalNodeId: string;
  agentName: string;
  label: string;
  nodeType: string;
  status: AgentRunNodeStatus;
  attempt: number;
  positionX: number;
  positionY: number;
  output: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface AgentRunEdge {
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
}

export interface AgentRunEvent {
  sequence: number;
  externalEventId: string;
  nodeId?: string;
  eventType: string;
  message: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface Notification {
  id: string;
  projectId: string;
  userId: string;
  taskId: string;
  commentId?: string;
  actorId: string;
  type: "MENTION" | "TASK_UPDATED";
  body: string;
  readAt?: string;
  createdAt: string;
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
  assigneeId?: string;
  tag?: string;
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
  customFields?: Record<string, string>;
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
  login(email: string, password: string): Promise<AuthUser>;
  register(displayName: string, email: string, password: string): Promise<AuthUser>;
  logout(): Promise<void>;
  me(): Promise<AuthUser | null>;
  listProjects(): Promise<Project[]>;
  createProject(name: string, description: string): Promise<Project>;
  bootstrap(projectId: string): Promise<WorkspaceBootstrap>;
  listMembers(projectId: string, filters?: MemberFilters): Promise<Page<Member>>;
  listMemberCandidates(projectId: string, filters?: Pick<MemberFilters, "search" | "cursor" | "limit">): Promise<Page<Member>>;
  addProjectMember(projectId: string, userId: string): Promise<Member>;
  listTasks(projectId: string, filters: TaskFilters): Promise<Page<Task>>;
  getTask(projectId: string, taskId: string): Promise<Task>;
  getLatestAgentRun(projectId: string, taskId: string): Promise<AgentRun | null>;
  createTask(projectId: string, title: string): Promise<Task>;
  updateTask(projectId: string, taskId: string, input: UpdateTaskInput): Promise<Task>;
  undoTask(projectId: string, taskId: string): Promise<Task>;
  redoTask(projectId: string, taskId: string): Promise<Task>;
  deleteTask(projectId: string, taskId: string, expectedVersion: number): Promise<{ id: string; deleted: true; version: number }>;
  listComments(projectId: string, taskId: string, cursor?: string): Promise<Page<Comment>>;
  createComment(projectId: string, taskId: string, body: string, clientId: string, parentId?: string): Promise<Comment>;
  setCommentReaction(projectId: string, taskId: string, commentId: string, type: CommentReactionType): Promise<CommentReaction>;
  removeCommentReaction(projectId: string, taskId: string, commentId: string): Promise<CommentReaction>;
  addDependency(projectId: string, taskId: string, dependencyTaskId: string): Promise<Dependency>;
  removeDependency(projectId: string, taskId: string, dependencyTaskId: string): Promise<Dependency>;
  listAssignmentHistory(projectId: string, taskId: string, cursor?: string): Promise<Page<AssignmentHistoryItem>>;
  listActivity(projectId: string, after?: string): Promise<Page<ActivityItem>>;
  listNotifications(projectId: string, unreadOnly?: boolean, cursor?: string): Promise<Page<Notification>>;
  markNotificationRead(projectId: string, notificationId: string): Promise<Notification>;
  listAttachments(projectId: string, taskId: string): Promise<Attachment[]>;
  uploadAttachment(projectId: string, taskId: string, file: File): Promise<Attachment>;
  deleteAttachment(projectId: string, taskId: string, attachmentId: string): Promise<Attachment>;
  attachmentUrl(projectId: string, taskId: string, attachmentId: string): string;
}
