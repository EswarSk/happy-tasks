import type {
  Comment,
  Member,
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
    accent: "#665cf6",
    version: 3,
  },
  {
    id: projectIds.mobile,
    name: "Mobile refresh",
    description: "A faster, calmer mobile experience.",
    taskCount: 86,
    updatedAt: "2026-08-26T19:12:00Z",
    accent: "#17a875",
    version: 1,
  },
  {
    id: projectIds.launch,
    name: "Fall launch",
    description: "Launch readiness across product and go-to-market.",
    taskCount: 142,
    updatedAt: "2026-08-25T15:05:00Z",
    accent: "#e88d2d",
    version: 2,
  },
];

export const demoMembers: Member[] = [
  { id: "00000000-0000-7000-8000-000000000001", displayName: "Avery Chen", email: "avery@example.com", color: "#5b5bd6" },
  { id: "00000000-0000-7000-8000-000000000002", displayName: "Maya Patel", email: "maya@example.com", color: "#0f9f6e" },
  { id: "00000000-0000-7000-8000-000000000003", displayName: "Noah Williams", email: "noah@example.com", color: "#d97706" },
  { id: "00000000-0000-7000-8000-000000000004", displayName: "Sofia Brooks", email: "sofia@example.com", color: "#db2777" },
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
}

declare global {
  var __happyTaskMockStore: MockStore | undefined;
}

function store(): MockStore {
  if (!globalThis.__happyTaskMockStore) {
    globalThis.__happyTaskMockStore = { tasks: new Map(), comments: new Map() };
  }
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
      accent: "#6258e8",
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
    if (input.expectedVersion !== task.version) {
      throw new WorkspaceApiError(409, { code: "VERSION_CONFLICT", message: "This task changed while you were editing it.", details: { current: structuredClone(task) } });
    }
    Object.assign(task, input, { version: task.version + 1, updatedAt: new Date().toISOString() });
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
}
