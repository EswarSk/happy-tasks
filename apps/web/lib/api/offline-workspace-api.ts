import { HttpWorkspaceApi } from "./http-workspace-api";
import type { AuthUser, Page, Project, Task, TaskFilters, UpdateTaskInput, WorkspaceBootstrap } from "./types";
import { WorkspaceApiError } from "./types";
import {
  actorCacheKey,
  clearOfflineActor,
  deleteOfflineOperation,
  filterCachedTasks,
  getActiveOfflineUser,
  getOfflineValue,
  listOfflineOperations,
  putOfflineOperation,
  setActiveOfflineUser,
  setOfflineValue,
  type OfflineOperation,
} from "@/lib/offline/store";
import { newRequestId } from "@/lib/utils";

export interface OfflineSyncSnapshot {
  pending: number;
  failed: number;
  conflicts: number;
  syncing: boolean;
  lastError?: string;
}

const emptySnapshot: OfflineSyncSnapshot = { pending: 0, failed: 0, conflicts: 0, syncing: false };
const isOnline = () => typeof navigator === "undefined" || navigator.onLine;
const isNetworkFailure = (error: unknown) => !isOnline() || error instanceof TypeError;
const cacheMiss = () => new WorkspaceApiError(503, { code: "OFFLINE_CACHE_MISS", message: "This data has not been opened on this device yet." });
const bestEffort = async (operation: Promise<unknown>) => { try { await operation; } catch { /* Online behavior must not fail because local storage is unavailable. */ } };

export class OfflineHttpWorkspaceApi extends HttpWorkspaceApi {
  private snapshot = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private syncPromise?: Promise<void>;

  getOfflineSnapshot = () => this.snapshot;

  subscribeOfflineSnapshot = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async hydrateOfflineState() {
    await this.refreshSnapshot();
  }

  async rememberTask(task: Task) {
    const actor = await getActiveOfflineUser();
    if (actor) await this.upsertTask(actor.id, task);
  }

  async forgetTask(projectId: string, taskId: string) {
    const actor = await getActiveOfflineUser();
    if (actor) await this.removeCachedTask(actor.id, projectId, taskId);
  }

  private publish(snapshot: OfflineSyncSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private async refreshSnapshot(syncing = this.snapshot.syncing, lastError = this.snapshot.lastError) {
    const actor = await getActiveOfflineUser();
    const operations = actor ? await listOfflineOperations(actor.id) : [];
    this.publish({
      pending: operations.filter((operation) => operation.status === "pending").length,
      failed: operations.filter((operation) => operation.status === "failed").length,
      conflicts: operations.filter((operation) => operation.status === "conflict").length,
      syncing,
      ...(lastError ? { lastError } : {}),
    });
  }

  private async actor(): Promise<AuthUser> {
    const cached = await getActiveOfflineUser();
    if (cached) return cached;
    if (!isOnline()) throw cacheMiss();
    const user = await super.me();
    if (!user) throw new WorkspaceApiError(401, { code: "AUTH_REQUIRED", message: "Sign in to continue." });
    await setActiveOfflineUser(user);
    return user;
  }

  private tasksKey(actorId: string, projectId: string) {
    return actorCacheKey(actorId, "tasks", projectId);
  }

  private async readTasks(actorId: string, projectId: string) {
    return getOfflineValue<Task[]>(this.tasksKey(actorId, projectId));
  }

  private async mergeTasks(actorId: string, projectId: string, incoming: Task[]) {
    const existing = await this.readTasks(actorId, projectId) ?? [];
    const merged = new Map(existing.map((task) => [task.id, task]));
    for (const task of incoming) merged.set(task.id, task);
    await setOfflineValue(this.tasksKey(actorId, projectId), [...merged.values()]);
  }

  private async upsertTask(actorId: string, task: Task) {
    const tasks = await this.readTasks(actorId, task.projectId) ?? [];
    const index = tasks.findIndex((item) => item.id === task.id);
    if (index === -1) tasks.unshift(task); else tasks[index] = task;
    await setOfflineValue(this.tasksKey(actorId, task.projectId), tasks);
  }

  private async removeCachedTask(actorId: string, projectId: string, taskId: string) {
    const tasks = await this.readTasks(actorId, projectId);
    if (tasks) await setOfflineValue(this.tasksKey(actorId, projectId), tasks.filter((task) => task.id !== taskId));
  }

  private async cachedTaskPage(actorId: string, projectId: string, filters: TaskFilters): Promise<Page<Task>> {
    const tasks = await this.readTasks(actorId, projectId);
    if (!tasks) throw cacheMiss();
    const items = filterCachedTasks(tasks, filters);
    return { items, nextCursor: null, totalCount: items.length };
  }

  private async taskHasOutbox(actorId: string, projectId: string, taskId?: string) {
    return (await listOfflineOperations(actorId)).some((operation) => operation.projectId === projectId && (!taskId || operation.taskId === taskId));
  }

  override async login(email: string, password: string) {
    const user = await super.login(email, password);
    await bestEffort(setActiveOfflineUser(user));
    await bestEffort(this.refreshSnapshot(false, undefined));
    return user;
  }

  override async register(displayName: string, email: string, password: string) {
    const user = await super.register(displayName, email, password);
    await bestEffort(setActiveOfflineUser(user));
    await bestEffort(this.refreshSnapshot(false, undefined));
    return user;
  }

  override async logout() {
    const actor = await getActiveOfflineUser();
    try {
      await super.logout();
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
    } finally {
      if (actor) await clearOfflineActor(actor.id);
      await setActiveOfflineUser(undefined);
      this.publish(emptySnapshot);
    }
  }

  override async me() {
    if (!isOnline()) return (await getActiveOfflineUser()) ?? null;
    try {
      const user = await super.me();
      await bestEffort(setActiveOfflineUser(user ?? undefined));
      return user;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      return (await getActiveOfflineUser()) ?? null;
    }
  }

  override async listProjects() {
    const actor = await this.actor();
    const key = actorCacheKey(actor.id, "projects");
    if (!isOnline()) {
      const cached = await getOfflineValue<Project[]>(key);
      if (!cached) throw cacheMiss();
      return cached;
    }
    try {
      const projects = await super.listProjects();
      await bestEffort(setOfflineValue(key, projects));
      return projects;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      const cached = await getOfflineValue<Project[]>(key);
      if (!cached) throw cacheMiss();
      return cached;
    }
  }

  override async bootstrap(projectId: string): Promise<WorkspaceBootstrap> {
    const actor = await this.actor();
    const key = actorCacheKey(actor.id, "bootstrap", projectId);
    if (!isOnline()) {
      const cached = await getOfflineValue<WorkspaceBootstrap>(key);
      if (!cached) throw cacheMiss();
      return cached;
    }
    try {
      const bootstrap = await super.bootstrap(projectId);
      await bestEffort(setOfflineValue(key, bootstrap));
      return bootstrap;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      const cached = await getOfflineValue<WorkspaceBootstrap>(key);
      if (!cached) throw cacheMiss();
      return cached;
    }
  }

  override async listTasks(projectId: string, filters: TaskFilters) {
    const actor = await this.actor();
    if (!isOnline() || await this.taskHasOutbox(actor.id, projectId)) return this.cachedTaskPage(actor.id, projectId, filters);
    try {
      const page = await super.listTasks(projectId, filters);
      await bestEffort(this.mergeTasks(actor.id, projectId, page.items));
      return page;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      return this.cachedTaskPage(actor.id, projectId, filters);
    }
  }

  override async getTask(projectId: string, taskId: string) {
    const actor = await this.actor();
    const cached = (await this.readTasks(actor.id, projectId))?.find((task) => task.id === taskId);
    if (!isOnline() || await this.taskHasOutbox(actor.id, projectId, taskId)) {
      if (!cached) throw cacheMiss();
      return cached;
    }
    try {
      const task = await super.getTask(projectId, taskId);
      await bestEffort(this.upsertTask(actor.id, task));
      return task;
    } catch (error) {
      if (!isNetworkFailure(error) || !cached) throw error;
      return cached;
    }
  }

  override async createTask(projectId: string, title: string) {
    const actor = await this.actor();
    const taskId = crypto.randomUUID();
    const idempotencyKey = newRequestId();
    if (isOnline()) {
      try {
        const task = await this.createTaskWithIdentity(projectId, title, taskId, idempotencyKey);
        await bestEffort(this.upsertTask(actor.id, task));
        return task;
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
      }
    }
    const now = new Date().toISOString();
    const task: Task = {
      id: taskId,
      projectId,
      key: `OFF-${taskId.replaceAll("-", "").slice(-6).toUpperCase()}`,
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
      updatedAt: now,
      version: 0,
      syncState: "pending",
    };
    await putOfflineOperation({ id: `${actor.id}:task.create:${projectId}:${taskId}`, actorId: actor.id, projectId, taskId, kind: "task.create", title, idempotencyKey, createdAt: now, status: "pending" });
    await bestEffort(this.upsertTask(actor.id, task));
    await this.refreshSnapshot();
    return task;
  }

  override async updateTask(projectId: string, taskId: string, input: UpdateTaskInput) {
    const actor = await this.actor();
    const operationId = `${actor.id}:task.update:${projectId}:${taskId}`;
    const operations = await listOfflineOperations(actor.id);
    const queuedOperation = operations.find((operation) => operation.id === operationId);
    const queued = queuedOperation?.kind === "task.update" ? queuedOperation : undefined;
    if (isOnline() && !queued && !await this.taskHasOutbox(actor.id, projectId, taskId)) {
      try {
        const task = await this.updateTaskWithIdentity(projectId, taskId, input, newRequestId());
        await bestEffort(this.upsertTask(actor.id, task));
        return task;
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
      }
    }
    const cached = (await this.readTasks(actor.id, projectId))?.find((task) => task.id === taskId);
    if (!cached) throw cacheMiss();
    const changes: Partial<UpdateTaskInput> = { ...input };
    delete changes.expectedVersion;
    const task: Task = { ...cached, ...changes, updatedAt: new Date().toISOString(), syncState: "pending" };
    const mergedInput: UpdateTaskInput = { ...(queued?.input ?? {}), ...input, expectedVersion: queued?.input.expectedVersion ?? input.expectedVersion };
    await putOfflineOperation({
      id: operationId,
      actorId: actor.id,
      projectId,
      taskId,
      kind: "task.update",
      input: mergedInput,
      idempotencyKey: queued?.idempotencyKey ?? newRequestId(),
      createdAt: queued?.createdAt ?? new Date().toISOString(),
      status: "pending",
    });
    await bestEffort(this.upsertTask(actor.id, task));
    await this.refreshSnapshot();
    return task;
  }

  override async deleteTask(projectId: string, taskId: string, expectedVersion: number) {
    const actor = await this.actor();
    const operations = await listOfflineOperations(actor.id);
    const create = operations.find((operation) => operation.taskId === taskId && operation.kind === "task.create");
    const update = operations.find((operation) => operation.taskId === taskId && operation.kind === "task.update");
    if (isOnline() && !create && !update) {
      try {
        const result = await this.deleteTaskWithIdentity(projectId, taskId, expectedVersion, newRequestId());
        await bestEffort(this.removeCachedTask(actor.id, projectId, taskId));
        return result;
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
      }
    }
    if (create) {
      await deleteOfflineOperation(create.id);
      if (update) await deleteOfflineOperation(update.id);
    } else {
      if (update) await deleteOfflineOperation(update.id);
      const now = new Date().toISOString();
      await putOfflineOperation({ id: `${actor.id}:task.delete:${projectId}:${taskId}`, actorId: actor.id, projectId, taskId, kind: "task.delete", expectedVersion, idempotencyKey: newRequestId(), createdAt: now, status: "pending" });
    }
    await bestEffort(this.removeCachedTask(actor.id, projectId, taskId));
    await this.refreshSnapshot();
    return { id: taskId, deleted: true as const, version: expectedVersion };
  }

  async syncOfflineChanges() {
    if (!isOnline()) return;
    this.syncPromise ??= this.performSync().finally(() => { this.syncPromise = undefined; });
    return this.syncPromise;
  }

  private async performSync() {
    const actor = await getActiveOfflineUser();
    if (!actor) return;
    this.publish({ ...this.snapshot, syncing: true, lastError: undefined });
    const versions = new Map<string, number>();
    const operations = (await listOfflineOperations(actor.id)).filter((operation) => operation.status === "pending");
    for (const operation of operations) {
      try {
        if (operation.kind === "task.create") {
          const task = await this.createTaskWithIdentity(operation.projectId, operation.title, operation.taskId, operation.idempotencyKey);
          versions.set(operation.taskId, task.version);
          await bestEffort(this.upsertTask(actor.id, { ...task, syncState: "synced" }));
        } else if (operation.kind === "task.update") {
          const expectedVersion = versions.get(operation.taskId) ?? operation.input.expectedVersion;
          const task = await this.updateTaskWithIdentity(operation.projectId, operation.taskId, { ...operation.input, expectedVersion }, operation.idempotencyKey);
          versions.set(operation.taskId, task.version);
          await bestEffort(this.upsertTask(actor.id, { ...task, syncState: "synced" }));
        } else {
          const expectedVersion = versions.get(operation.taskId) ?? operation.expectedVersion;
          await this.deleteTaskWithIdentity(operation.projectId, operation.taskId, expectedVersion, operation.idempotencyKey);
          await bestEffort(this.removeCachedTask(actor.id, operation.projectId, operation.taskId));
        }
        await deleteOfflineOperation(operation.id);
      } catch (error) {
        if (isNetworkFailure(error)) break;
        const status = error instanceof WorkspaceApiError && error.status === 409 ? "conflict" : "failed";
        const failed: OfflineOperation = { ...operation, status, error: error instanceof Error ? error.message : "Sync failed" };
        await putOfflineOperation(failed);
        const cached = (await this.readTasks(actor.id, operation.projectId))?.find((task) => task.id === operation.taskId);
        if (cached) {
          // A sibling operation earlier in this same sync batch (e.g. the
          // create) may have already overwritten the cache with the server's
          // pre-edit value. Re-apply this operation's own attempted fields so
          // the user's unsynced edit stays visible instead of silently
          // reverting to the server value.
          const attempted: Partial<UpdateTaskInput> = operation.kind === "task.update" ? { ...operation.input } : {};
          delete attempted.expectedVersion;
          await this.upsertTask(actor.id, { ...cached, ...attempted, syncState: status });
        }
      }
    }
    await this.refreshSnapshot(false);
  }

  async discardBlockedChanges() {
    const actor = await getActiveOfflineUser();
    if (!actor) return;
    const blocked = (await listOfflineOperations(actor.id)).filter((operation) => operation.status !== "pending");
    for (const operation of blocked) {
      await deleteOfflineOperation(operation.id);
      await this.removeCachedTask(actor.id, operation.projectId, operation.taskId);
    }
    await this.refreshSnapshot(false);
  }

}
