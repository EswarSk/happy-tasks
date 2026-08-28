import type {
  AssignmentHistoryItem,
  ActivityItem,
  Comment,
  CommentReaction,
  CommentReactionType,
  Member,
  MemberFilters,
  Notification,
  Page,
  Project,
  Task,
  TaskFilters,
  UpdateTaskInput,
  WorkspaceApi,
  WorkspaceBootstrap,
} from "./types";
import { WorkspaceApiError } from "./types";

const projectIds = {
  platform: "7f455922-1a88-7000-8000-000000000001",
  mobile: "7f455922-1a88-7000-8000-000000000002",
  launch: "7f455922-1a88-7000-8000-000000000003",
};

export const demoProjectId = projectIds.platform;
export const demoTaskId = `${projectIds.platform.slice(0, -4)}0101`;

const projects: Project[] = [
  {
    id: projectIds.platform,
    name: "Project Atlas",
    description: "Ship a resilient collaborative workspace for high-velocity teams.",
    taskCount: 10_000,
    updatedAt: "2026-08-26T21:42:00Z",
    accent: "#18181b",
    version: 3,
  },
  {
    id: projectIds.mobile,
    name: "Mobile refresh",
    description: "A faster, calmer mobile experience.",
    taskCount: 86,
    updatedAt: "2026-08-26T19:12:00Z",
    accent: "#52525b",
    version: 1,
  },
  {
    id: projectIds.launch,
    name: "Fall launch",
    description: "Launch readiness across product and go-to-market.",
    taskCount: 142,
    updatedAt: "2026-08-25T15:05:00Z",
    accent: "#a1a1aa",
    version: 2,
  },
];

export const demoMembers: Member[] = [
  { id: "00000000-0000-7000-8000-000000000001", displayName: "Maya Chen", email: "maya@example.test", color: "#18181b" },
  { id: "00000000-0000-7000-8000-000000000002", displayName: "Avery Chen", email: "avery@example.test", color: "#3f3f46" },
  { id: "00000000-0000-7000-8000-000000000003", displayName: "Noah Williams", email: "noah@example.com", color: "#52525b" },
  { id: "00000000-0000-7000-8000-000000000004", displayName: "Sofia Brooks", email: "sofia@example.com", color: "#71717a" },
];

const titles = [
  "Design project event replay semantics",
  "Add optimistic task updates",
  "Verify dependency cycle detection",
  "Build accessible project navigation",
  "Measure task-list query latency",
  "Document reconnect recovery flow",
  "Create deterministic scale seed",
  "Review comment pagination indexes",
  "Add structured API error states",
  "Prepare two-browser sync scenario",
  "Tune bounded SSE client queues",
  "Polish mobile task details",
];

const statusCycle: Task["status"][] = ["in_progress", "todo", "done", "todo", "blocked"];
const priorityCycle: Task["priority"][] = ["high", "medium", "urgent", "low", "medium"];
const tagCycle = ["Realtime", "Frontend", "Backend", "Scale", "Accessibility", "Docs"];

function makeTasks(project: Project): Task[] {
  return Array.from({ length: project.taskCount }, (_, index) => {
    const taskNumber = index + 101;
    return {
      id: `${project.id.slice(0, -4)}${String(taskNumber).padStart(4, "0")}`,
      projectId: project.id,
      key: `ATL-${taskNumber}`,
      title: index < titles.length ? titles[index] : `${titles[index % titles.length]} #${Math.floor(index / titles.length) + 1}`,
      description:
        index === 0
          ? "Define durable, ordered event replay so reconnecting clients recover every committed change without downloading the full project."
          : "A focused delivery item for the collaborative workspace. Keep the implementation measurable, accessible, and easy to evolve.",
      status: statusCycle[index % statusCycle.length],
      priority: priorityCycle[index % priorityCycle.length],
      assigneeIds: index % 7 === 0 ? [] : [demoMembers[index % demoMembers.length].id],
      tags: [tagCycle[index % tagCycle.length]],
      dependencyIds: index > 1 && index % 6 === 0 ? [`${project.id.slice(0, -4)}${String(taskNumber - 1).padStart(4, "0")}`] : [],
      blockingCount: index % 9 === 0 ? 2 : 0,
      commentCount: index === 0 ? 6 : index % 8,
      customFields: { effort: ["S", "M", "L"][index % 3], area: tagCycle[index % tagCycle.length] },
      updatedAt: new Date(Date.UTC(2026, 7, 26, 21, 42) - index * 61_000).toISOString(),
      version: 1 + (index % 8),
    };
  });
}

interface MockStore {
  tasks: Map<string, Task[]>;
  comments: Map<string, Comment[]>;
  reactions: Map<string, Map<string, CommentReactionType>>;
  activity: Map<string, ActivityItem[]>;
  notifications: Map<string, Notification[]>;
  assignmentHistory: Map<string, AssignmentHistoryItem[]>;
  operations: Map<string, MockTaskOperation[]>;
}

interface MockTaskOperation {
  id: string;
  actorId: string;
  fields: string[];
  before: Partial<Task>;
  after: Partial<Task>;
  state: "ACTIVE" | "UNDONE" | "INVALIDATED";
}

declare global {
  var __happyTaskMockStore: MockStore | undefined;
}

function store(): MockStore {
  if (!globalThis.__happyTaskMockStore) {
    globalThis.__happyTaskMockStore = { tasks: new Map(), comments: new Map(), reactions: new Map(), activity: new Map(), notifications: new Map(), assignmentHistory: new Map(), operations: new Map() };
  }
  // Preserve hot-reload compatibility with a store created before assignment history existed.
  globalThis.__happyTaskMockStore.assignmentHistory ??= new Map();
  globalThis.__happyTaskMockStore.operations ??= new Map();
  globalThis.__happyTaskMockStore.reactions ??= new Map();
  globalThis.__happyTaskMockStore.activity ??= new Map();
  globalThis.__happyTaskMockStore.notifications ??= new Map();
  return globalThis.__happyTaskMockStore;
}

function tasksFor(projectId: string) {
  const state = store();
  if (!state.tasks.has(projectId)) {
    const project = projects.find((item) => item.id === projectId) ?? projects[0];
    state.tasks.set(projectId, makeTasks(project));
  }
  return state.tasks.get(projectId)!;
}

function commentsFor(taskId: string) {
  const state = store();
  if (!state.comments.has(taskId)) {
    state.comments.set(taskId, [
      { id: `${taskId}-comment-1`, projectId: projectIds.platform, taskId, authorId: demoMembers[1].id, body: "Replay should begin after the bootstrap cursor so there is no lost-update window.", createdAt: "2026-08-26T18:20:00Z", version: 1 },
      { id: `${taskId}-comment-2`, projectId: projectIds.platform, taskId, parentId: `${taskId}-comment-1`, authorId: demoMembers[2].id, body: "I added a focused two-client scenario to the acceptance notes. This should be great to demo live.", createdAt: "2026-08-26T19:05:00Z", version: 1 },
      { id: `${taskId}-comment-3`, projectId: projectIds.platform, taskId, parentId: `${taskId}-comment-2`, authorId: demoMembers[0].id, body: "Perfect. Let’s also show the event payload in DevTools so reviewers can see it stays compact.", createdAt: "2026-08-26T20:32:00Z", version: 1 },
    ]);
  }
  return state.comments.get(taskId)!;
}

function recordActivity(projectId: string, eventType: string, description: string, aggregateId: string) {
  const items = store().activity.get(projectId) ?? [];
  items.unshift({ id: crypto.randomUUID(), projectId, sequence: items.length + 1, eventType, aggregateType: eventType.split(".")[0] ?? "task", aggregateId, actorId: demoMembers[0].id, description, occurredAt: new Date().toISOString() });
  store().activity.set(projectId, items.slice(0, 100));
}

function recordMentionNotifications(projectId: string, taskId: string, commentId: string, actorId: string, body: string) {
  const handles = new Set([...body.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)].map((match) => match[1].toLowerCase()));
  const now = new Date().toISOString();
  const notifications = [...(store().notifications.get(projectId) ?? [])];
  for (const member of demoMembers) {
    const handle = member.email.split("@")[0].toLowerCase();
    if (member.id === actorId || !handles.has(handle)) continue;
    notifications.unshift({ id: crypto.randomUUID(), projectId, userId: member.id, taskId, commentId, actorId, type: "MENTION", body: "You were mentioned in a comment.", createdAt: now });
  }
  store().notifications.set(projectId, notifications.slice(0, 100));
}

function reactionsFor(commentId: string) {
  const reactions = store().reactions.get(commentId) ?? new Map<string, CommentReactionType>();
  store().reactions.set(commentId, reactions);
  return reactions;
}

function reactionSummary(projectId: string, taskId: string, commentId: string): CommentReaction[] {
  const reactions = reactionsFor(commentId);
  return (["like", "celebrate", "insightful"] as CommentReactionType[])
    .filter((type) => [...reactions.values()].some((value) => value === type))
    .map((type) => ({ projectId, taskId, commentId, type, count: [...reactions.values()].filter((value) => value === type).length, reacted: reactions.get(demoMembers[0].id) === type }));
}

function assignmentHistoryFor(projectId: string, taskId: string) {
  const state = store();
  if (!state.assignmentHistory.has(taskId)) {
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    const initial = (task?.assigneeIds ?? []).map((userId, index): AssignmentHistoryItem => ({
      id: `${taskId}-assignment-${index}`,
      projectId,
      taskId,
      userId,
      membershipId: `membership-${userId}`,
      operation: "ASSIGNED",
      actorId: demoMembers[0].id,
      requestId: `${taskId}-assignment-request-${index}`,
      occurredAt: task?.updatedAt ?? new Date().toISOString(),
    }));
    state.assignmentHistory.set(taskId, initial);
  }
  return state.assignmentHistory.get(taskId)!;
}

const delay = (ms = 260) => new Promise((resolve) => setTimeout(resolve, ms));

function offsetFromCursor(cursor?: string) {
  if (!cursor) return 0;
  const parsed = Number(cursor.replace("cursor_", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export class MockWorkspaceApi implements WorkspaceApi {
  async listProjects() {
    await delay(120);
    return structuredClone(projects);
  }

  async createProject(name: string, description: string) {
    await delay(360);
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      description,
      taskCount: 0,
      updatedAt: new Date().toISOString(),
      accent: "#18181b",
      version: 1,
    };
    projects.unshift(project);
    store().tasks.set(project.id, []);
    recordActivity(project.id, "project.created", "created the project", project.id);
    return structuredClone(project);
  }

  async bootstrap(projectId: string): Promise<WorkspaceBootstrap> {
    await delay(160);
    const project = projects.find((item) => item.id === projectId) ?? projects[0];
    return { project: structuredClone(project), members: structuredClone(demoMembers), streamCursor: 1842 };
  }

  async listMembers(_projectId: string, filters: MemberFilters = {}): Promise<Page<Member>> {
    await delay(120);
    const search = filters.search?.trim().toLowerCase();
    const filtered = demoMembers.filter((member) => {
      if (filters.status && filters.status !== (member.membershipStatus ?? "ACTIVE")) return false;
      if (filters.role && filters.role !== (member.role ?? "MEMBER")) return false;
      return !search || `${member.displayName} ${member.email}`.toLowerCase().includes(search);
    });
    const offset = offsetFromCursor(filters.cursor);
    const limit = filters.limit ?? 50;
    const items = filtered.slice(offset, offset + limit);
    return {
      items: structuredClone(items),
      nextCursor: offset + limit < filtered.length ? `cursor_${offset + limit}` : null,
      totalCount: filtered.length,
    };
  }

  async listTasks(projectId: string, filters: TaskFilters): Promise<Page<Task>> {
    await delay(240);
    const limit = filters.limit ?? 100;
    const search = filters.search?.trim().toLowerCase();
    const filtered = tasksFor(projectId).filter((task) => {
      if (search && !`${task.key} ${task.title} ${task.tags.join(" ")}`.toLowerCase().includes(search)) return false;
      if (filters.status && filters.status !== "all" && task.status !== filters.status) return false;
      if (filters.priority && filters.priority !== "all" && task.priority !== filters.priority) return false;
      if (filters.assigneeId && !task.assigneeIds.includes(filters.assigneeId)) return false;
      if (filters.tag && !task.tags.some((item) => item.toLowerCase().includes(filters.tag!.trim().toLowerCase()))) return false;
      return true;
    });
    const offset = offsetFromCursor(filters.cursor);
    const items = filtered.slice(offset, offset + limit);
    return {
      items: structuredClone(items),
      nextCursor: offset + limit < filtered.length ? `cursor_${offset + limit}` : null,
      totalCount: filtered.length,
    };
  }

  async getTask(projectId: string, taskId: string) {
    await delay(130);
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    if (!task) throw new WorkspaceApiError(404, { code: "TASK_NOT_FOUND", message: "Task not found." });
    return structuredClone(task);
  }

  async createTask(projectId: string, title: string) {
    await delay(520);
    const list = tasksFor(projectId);
    const id = crypto.randomUUID();
    const task: Task = {
      id,
      projectId,
      key: `ATL-${101 + list.length}`,
      title,
      description: "",
      status: "todo",
      priority: "medium",
      assigneeIds: [],
      tags: [],
      dependencyIds: [],
      blockingCount: 0,
      commentCount: 0,
      customFields: {},
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    list.unshift(task);
    recordActivity(projectId, "task.created", "created a task", task.id);
    return structuredClone(task);
  }

  async updateTask(projectId: string, taskId: string, input: UpdateTaskInput) {
    await delay(560);
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    if (!task) throw new WorkspaceApiError(404, { code: "TASK_NOT_FOUND", message: "Task not found." });
    const fields = Object.keys(input).filter((field) => field !== "expectedVersion");
    const operations = store().operations.get(taskId) ?? [];
    if (input.expectedVersion < 1 || input.expectedVersion > task.version || (input.expectedVersion < task.version && operations.some((operation) => operation.state !== "INVALIDATED" && operation.fields.some((field) => fields.includes(field))))) {
      throw new WorkspaceApiError(409, { code: "VERSION_CONFLICT", message: "This task changed while you were editing it.", details: { current: structuredClone(task) } });
    }
    const before: Partial<Task> = {};
    const after: Partial<Task> = {};
    for (const field of fields) {
      const key = field as keyof Task;
      before[key] = structuredClone(task[key]) as never;
    }
    const previousAssigneeIds = new Set(task.assigneeIds);
    const assignmentHistory = input.assigneeIds ? assignmentHistoryFor(projectId, taskId) : undefined;
    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.status !== undefined) task.status = input.status;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.customFields !== undefined) task.customFields = structuredClone(input.customFields);
    if (input.assigneeIds !== undefined) task.assigneeIds = [...input.assigneeIds];
    if (input.tags !== undefined) task.tags = [...input.tags];
    task.version += 1;
    task.updatedAt = new Date().toISOString();
    recordActivity(projectId, "task.updated", "updated a task", task.id);
    for (const field of fields) {
      const key = field as keyof Task;
      after[key] = structuredClone(task[key]) as never;
    }
    if (input.assigneeIds) {
      const nextAssigneeIds = new Set(input.assigneeIds);
      const changes = [
        ...input.assigneeIds.filter((userId) => !previousAssigneeIds.has(userId)).map((userId) => ({ userId, operation: "ASSIGNED" as const })),
        ...[...previousAssigneeIds].filter((userId) => !nextAssigneeIds.has(userId)).map((userId) => ({ userId, operation: "UNASSIGNED" as const })),
      ];
      const occurredAt = new Date().toISOString();
      assignmentHistory!.unshift(...changes.map(({ userId, operation }) => ({
        id: crypto.randomUUID(),
        projectId,
        taskId,
        userId,
        membershipId: `membership-${userId}`,
        operation,
        actorId: demoMembers[0].id,
        requestId: crypto.randomUUID(),
        occurredAt,
      })));
    }
    const operation: MockTaskOperation = { id: crypto.randomUUID(), actorId: demoMembers[0].id, fields, before, after, state: "ACTIVE" };
    for (const previous of operations) if (previous.state === "UNDONE") previous.state = "INVALIDATED";
    operations.push(operation);
    store().operations.set(taskId, operations);
    return structuredClone(task);
  }

  async undoTask(projectId: string, taskId: string) {
    await delay(280);
    return this.replayOperation(projectId, taskId, "ACTIVE", "UNDONE");
  }

  async redoTask(projectId: string, taskId: string) {
    await delay(280);
    return this.replayOperation(projectId, taskId, "UNDONE", "ACTIVE");
  }

  private replayOperation(projectId: string, taskId: string, from: MockTaskOperation["state"], to: MockTaskOperation["state"]) {
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    const operation = [...(store().operations.get(taskId) ?? [])].reverse().find((item) => item.state === from);
    if (!task || !operation) throw new WorkspaceApiError(422, { code: to === "UNDONE" ? "UNDO_NOT_AVAILABLE" : "REDO_NOT_AVAILABLE", message: to === "UNDONE" ? "There is no task edit available to undo." : "There is no task edit available to redo." });
    const expected = to === "UNDONE" ? operation.after : operation.before;
    for (const field of operation.fields) {
      if (JSON.stringify(task[field as keyof Task]) !== JSON.stringify(expected[field as keyof Task])) {
        throw new WorkspaceApiError(409, { code: "OPERATION_CONFLICT", message: "This edit conflicts with a collaborator's change." });
      }
    }
    const target = to === "UNDONE" ? operation.before : operation.after;
    for (const field of operation.fields) (task[field as keyof Task] as never) = structuredClone(target[field as keyof Task]) as never;
    task.version += 1;
    task.updatedAt = new Date().toISOString();
    operation.state = to;
    recordActivity(projectId, "task.updated", to === "UNDONE" ? "undid a task edit" : "redid a task edit", task.id);
    return structuredClone(task);
  }

  async deleteTask(projectId: string, taskId: string, expectedVersion: number) {
    await delay(420);
    const list = tasksFor(projectId);
    const index = list.findIndex((item) => item.id === taskId);
    if (index === -1) throw new WorkspaceApiError(404, { code: "TASK_NOT_FOUND", message: "Task not found." });
    const task = list[index];
    if (task.version !== expectedVersion) {
      throw new WorkspaceApiError(409, { code: "VERSION_CONFLICT", message: "This task changed before it could be deleted." });
    }
    list.splice(index, 1);
    store().comments.delete(taskId);
    store().assignmentHistory.delete(taskId);
    recordActivity(projectId, "task.deleted", "deleted a task", taskId);
    return { id: taskId, deleted: true as const, version: expectedVersion + 1 };
  }

  async listComments(projectId: string, taskId: string, cursor?: string): Promise<Page<Comment>> {
    await delay(180);
    const items = [...commentsFor(taskId)].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = cursor ? Number(cursor) : 0;
    const pageSize = 50;
    const page = items.slice(offset, offset + pageSize);
    const nextCursor = offset + pageSize < items.length ? String(offset + pageSize) : null;
    return { items: structuredClone(page.map((comment) => ({ ...comment, reactions: reactionSummary(projectId, taskId, comment.id) }))), nextCursor, totalCount: page.length };
  }

  async createComment(projectId: string, taskId: string, body: string, clientId: string, parentId?: string) {
    await delay(620);
    if (body.toLowerCase().includes("/fail")) {
      throw new WorkspaceApiError(503, { code: "DEMO_FAILURE", message: "Demo failure triggered. Your comment is preserved for retry." });
    }
    const existing = commentsFor(taskId).find((comment) => comment.id === clientId);
    if (existing) return structuredClone(existing);
    if (parentId && !commentsFor(taskId).some((comment) => comment.id === parentId)) {
      throw new WorkspaceApiError(422, { code: "COMMENT_PARENT_NOT_FOUND", message: "The parent comment does not exist on this task." });
    }
    const comment: Comment = { id: clientId, projectId, taskId, ...(parentId ? { parentId } : {}), authorId: demoMembers[0].id, body, createdAt: new Date().toISOString(), version: 1 };
    commentsFor(taskId).push(comment);
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    if (task) task.commentCount += 1;
    recordActivity(projectId, "comment.created", "added a comment", comment.id);
    recordMentionNotifications(projectId, taskId, comment.id, demoMembers[0].id, body);
    return structuredClone(comment);
  }

  async setCommentReaction(projectId: string, taskId: string, commentId: string, type: CommentReactionType) {
    await delay(180);
    if (!commentsFor(taskId).some((comment) => comment.id === commentId)) throw new WorkspaceApiError(404, { code: "NOT_FOUND", message: "The comment was not found." });
    reactionsFor(commentId).set(demoMembers[0].id, type);
    const summary = reactionSummary(projectId, taskId, commentId).find((item) => item.type === type)!;
    recordActivity(projectId, "comment.reaction.changed", "reacted to a comment", commentId);
    return structuredClone(summary);
  }

  async removeCommentReaction(projectId: string, taskId: string, commentId: string) {
    await delay(180);
    if (!commentsFor(taskId).some((comment) => comment.id === commentId)) throw new WorkspaceApiError(404, { code: "NOT_FOUND", message: "The comment was not found." });
    const reactions = reactionsFor(commentId);
    const previous = reactions.get(demoMembers[0].id);
    reactions.delete(demoMembers[0].id);
    const summary = previous ? reactionSummary(projectId, taskId, commentId).find((item) => item.type === previous) : undefined;
    const result: CommentReaction = summary ?? { projectId, taskId, commentId, type: previous ?? "like", count: 0, reacted: false };
    recordActivity(projectId, "comment.reaction.changed", "removed a comment reaction", commentId);
    return result;
  }

  async addDependency(projectId: string, taskId: string, dependencyTaskId: string) {
    await delay(480);
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    if (!task) throw new WorkspaceApiError(404, { code: "TASK_NOT_FOUND", message: "Task not found." });
    if (taskId === dependencyTaskId || dependencyTaskId.endsWith("0102")) {
      throw new WorkspaceApiError(422, { code: "DEPENDENCY_CYCLE", message: "Adding this dependency would create a cycle." });
    }
    if (!task.dependencyIds.includes(dependencyTaskId)) task.dependencyIds.push(dependencyTaskId);
    task.version += 1;
    recordActivity(projectId, "dependency.created", "added a dependency", taskId);
    return { taskId, dependsOnTaskId: dependencyTaskId };
  }

  async removeDependency(projectId: string, taskId: string, dependencyTaskId: string) {
    await delay(320);
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    if (!task) throw new WorkspaceApiError(404, { code: "TASK_NOT_FOUND", message: "Task not found." });
    task.dependencyIds = task.dependencyIds.filter((id) => id !== dependencyTaskId);
    task.version += 1;
    recordActivity(projectId, "dependency.deleted", "removed a dependency", taskId);
    return { taskId, dependsOnTaskId: dependencyTaskId, deleted: true };
  }

  async listAssignmentHistory(projectId: string, taskId: string, cursor?: string): Promise<Page<AssignmentHistoryItem>> {
    await delay(160);
    const items = assignmentHistoryFor(projectId, taskId);
    const offset = cursor ? Number(cursor) : 0;
    const pageSize = 50;
    const page = items.slice(offset, offset + pageSize);
    return {
      items: structuredClone(page),
      nextCursor: offset + pageSize < items.length ? String(offset + pageSize) : null,
      totalCount: items.length,
    };
  }

  async listActivity(projectId: string, after?: string): Promise<Page<ActivityItem>> {
    await delay(120);
    const items = store().activity.get(projectId) ?? [
      { id: `${projectId}:3`, projectId, sequence: 3, eventType: "task.updated", aggregateType: "task", aggregateId: demoTaskId, actorId: demoMembers[1].id, description: "updated a task", occurredAt: "2026-08-26T21:42:00Z" },
      { id: `${projectId}:2`, projectId, sequence: 2, eventType: "comment.created", aggregateType: "comment", aggregateId: `${demoTaskId}-comment-1`, actorId: demoMembers[2].id, description: "added a comment", occurredAt: "2026-08-26T20:32:00Z" },
      { id: `${projectId}:1`, projectId, sequence: 1, eventType: "task.created", aggregateType: "task", aggregateId: demoTaskId, actorId: demoMembers[0].id, description: "created a task", occurredAt: "2026-08-26T18:20:00Z" },
    ];
    if (!store().activity.has(projectId)) store().activity.set(projectId, items);
    const minimum = Number(after ?? "0");
    const page = items.filter((item) => item.sequence > minimum).slice(0, 50);
    return { items: structuredClone(page), nextCursor: page.length === 50 ? String(page.at(-1)?.sequence ?? minimum) : null, totalCount: page.length };
  }

  async listNotifications(projectId: string, unreadOnly = true, cursor?: string): Promise<Page<Notification>> {
    await delay(120);
    const seeded: Notification[] = projectId === demoProjectId ? [{ id: `${projectId}-notification-1`, projectId, userId: demoMembers[0].id, taskId: demoTaskId, commentId: `${demoTaskId}-comment-1`, actorId: demoMembers[1].id, type: "MENTION", body: "You were mentioned in a comment.", createdAt: "2026-08-26T20:32:00Z" }] : [];
    const items = store().notifications.get(projectId) ?? [];
    if (projectId === demoProjectId && items.length === 0) items.push(...seeded);
    if (!store().notifications.has(projectId) || seeded.length > 0 && items.length > 0) store().notifications.set(projectId, items);
    const offset = Number(cursor ?? 0);
    const filtered = unreadOnly ? items.filter((item) => !item.readAt) : items;
    const page = filtered.slice(offset, offset + 50);
    return { items: structuredClone(page), nextCursor: offset + 50 < filtered.length ? String(offset + 50) : null, totalCount: filtered.length };
  }

  async markNotificationRead(projectId: string, notificationId: string) {
    await delay(100);
    const notification = store().notifications.get(projectId)?.find((item) => item.id === notificationId);
    if (!notification) throw new WorkspaceApiError(404, { code: "NOTIFICATION_NOT_FOUND", message: "Notification not found." });
    notification.readAt = new Date().toISOString();
    return structuredClone(notification);
  }
}
