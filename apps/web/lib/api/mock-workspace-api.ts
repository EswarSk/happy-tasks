import type {
  AssignmentHistoryItem,
  Comment,
  Member,
  MemberFilters,
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
    globalThis.__happyTaskMockStore = { tasks: new Map(), comments: new Map(), assignmentHistory: new Map(), operations: new Map() };
  }
  // Preserve hot-reload compatibility with a store created before assignment history existed.
  globalThis.__happyTaskMockStore.assignmentHistory ??= new Map();
  globalThis.__happyTaskMockStore.operations ??= new Map();
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
      { id: `${taskId}-comment-2`, projectId: projectIds.platform, taskId, authorId: demoMembers[2].id, body: "I added a focused two-client scenario to the acceptance notes. This should be great to demo live.", createdAt: "2026-08-26T19:05:00Z", version: 1 },
      { id: `${taskId}-comment-3`, projectId: projectIds.platform, taskId, authorId: demoMembers[0].id, body: "Perfect. Let’s also show the event payload in DevTools so reviewers can see it stays compact.", createdAt: "2026-08-26T20:32:00Z", version: 1 },
    ]);
  }
  return state.comments.get(taskId)!;
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
    return { id: taskId, deleted: true as const, version: expectedVersion + 1 };
  }

  async listComments(projectId: string, taskId: string, cursor?: string): Promise<Page<Comment>> {
    await delay(180);
    const items = [...commentsFor(taskId)].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = cursor ? Number(cursor) : 0;
    const pageSize = 50;
    const page = items.slice(offset, offset + pageSize);
    const nextCursor = offset + pageSize < items.length ? String(offset + pageSize) : null;
    return { items: structuredClone(page), nextCursor, totalCount: page.length };
  }

  async createComment(projectId: string, taskId: string, body: string, clientId: string) {
    await delay(620);
    if (body.toLowerCase().includes("/fail")) {
      throw new WorkspaceApiError(503, { code: "DEMO_FAILURE", message: "Demo failure triggered. Your comment is preserved for retry." });
    }
    const existing = commentsFor(taskId).find((comment) => comment.id === clientId);
    if (existing) return structuredClone(existing);
    const comment: Comment = { id: clientId, projectId, taskId, authorId: demoMembers[0].id, body, createdAt: new Date().toISOString(), version: 1 };
    commentsFor(taskId).push(comment);
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    if (task) task.commentCount += 1;
    return structuredClone(comment);
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
    return { taskId, dependsOnTaskId: dependencyTaskId };
  }

  async removeDependency(projectId: string, taskId: string, dependencyTaskId: string) {
    await delay(320);
    const task = tasksFor(projectId).find((item) => item.id === taskId);
    if (!task) throw new WorkspaceApiError(404, { code: "TASK_NOT_FOUND", message: "Task not found." });
    task.dependencyIds = task.dependencyIds.filter((id) => id !== dependencyTaskId);
    task.version += 1;
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
}
