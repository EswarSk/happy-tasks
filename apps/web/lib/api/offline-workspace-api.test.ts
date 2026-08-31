import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineHttpWorkspaceApi } from "./offline-workspace-api";
import { clearOfflineActor, listOfflineOperations, setActiveOfflineUser } from "@/lib/offline/store";

const actor = { id: "00000000-0000-7000-8000-000000000001", displayName: "Maya Chen", email: "maya@example.test" };
const projectId = "01000000-0000-7000-8000-000000000001";

describe("offline task outbox", () => {
  beforeEach(async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await clearOfflineActor(actor.id);
    await setActiveOfflineUser(actor);
  });

  afterEach(async () => {
    await clearOfflineActor(actor.id);
    await setActiveOfflineUser(undefined);
    vi.unstubAllGlobals();
  });

  it("caches task edits and coalesces them until reconnect", async () => {
    const api = new OfflineHttpWorkspaceApi("http://127.0.0.1:1");
    const created = await api.createTask(projectId, "Prepare the offline release");
    const renamed = await api.updateTask(projectId, created.id, { title: "Ship the offline release", expectedVersion: created.version });
    const updated = await api.updateTask(projectId, created.id, { priority: "urgent", expectedVersion: created.version });

    expect(renamed.syncState).toBe("pending");
    expect(updated).toMatchObject({ title: "Ship the offline release", priority: "urgent", syncState: "pending" });
    expect((await api.listTasks(projectId, { priority: "urgent" })).items).toEqual([updated]);

    const operations = await listOfflineOperations(actor.id);
    expect(operations).toHaveLength(2);
    expect(operations.find((operation) => operation.kind === "task.update")).toMatchObject({
      input: { title: "Ship the offline release", priority: "urgent", expectedVersion: 0 },
    });
  });

  it("drops unsynced creates instead of sending a pointless delete", async () => {
    const api = new OfflineHttpWorkspaceApi("http://127.0.0.1:1");
    const created = await api.createTask(projectId, "Temporary offline task");
    await api.deleteTask(projectId, created.id, created.version);

    expect(await listOfflineOperations(actor.id)).toEqual([]);
    expect((await api.listTasks(projectId, {})).items).toEqual([]);
  });

  it("replays queued changes in order and stores the server version", async () => {
    const api = new OfflineHttpWorkspaceApi("http://api.test");
    const created = await api.createTask(projectId, "Queued title");
    await api.updateTask(projectId, created.id, { priority: "urgent", expectedVersion: 0 });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
      const task = {
        id: created.id,
        projectId,
        key: "TSK-101",
        title: "Queued title",
        description: "",
        status: "TODO",
        priority: body.priority ?? "MEDIUM",
        assigneeIds: [],
        tags: [],
        dependencyIds: [],
        blockingCount: 0,
        commentCount: 0,
        customFields: {},
        updatedAt: "2026-08-30T18:00:00.000Z",
        version: init?.method === "PATCH" ? 2 : 1,
      };
      return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { onLine: true });

    await api.syncOfflineChanges();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await listOfflineOperations(actor.id)).toEqual([]);
    vi.stubGlobal("navigator", { onLine: false });
    expect(await api.getTask(projectId, created.id)).toMatchObject({ key: "TSK-101", priority: "urgent", version: 2, syncState: "synced" });
  });

  it("keeps conflicts visible until the user chooses the server version", async () => {
    const api = new OfflineHttpWorkspaceApi("http://api.test");
    const created = await api.createTask(projectId, "Conflicting task");
    await api.updateTask(projectId, created.id, { title: "Offline title", expectedVersion: 0 });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "Task changed elsewhere." } }), { status: 409, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        ...created,
        key: "TSK-102",
        status: "TODO",
        priority: "MEDIUM",
        version: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { onLine: true });

    await api.syncOfflineChanges();
    await api.hydrateOfflineState();

    expect(api.getOfflineSnapshot()).toMatchObject({ pending: 0, conflicts: 1 });
    vi.stubGlobal("navigator", { onLine: false });
    expect(await api.getTask(projectId, created.id)).toMatchObject({ title: "Offline title", syncState: "conflict" });
    await api.discardBlockedChanges();
    expect(await listOfflineOperations(actor.id)).toEqual([]);
  });
});
