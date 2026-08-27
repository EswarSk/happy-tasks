import { describe, expect, it } from "vitest";
import { demoProjectId, demoTaskId, MockWorkspaceApi } from "./mock-workspace-api";

describe("MockWorkspaceApi", () => {
  it("provides cursor pages over the 10,000-task scale fixture", async () => {
    const api = new MockWorkspaceApi();
    const first = await api.listTasks(demoProjectId, { limit: 25 });
    const second = await api.listTasks(demoProjectId, { limit: 25, cursor: first.nextCursor ?? undefined });

    expect(first.totalCount).toBe(10_000);
    expect(first.items).toHaveLength(25);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("models a version conflict with a stable error code", async () => {
    const api = new MockWorkspaceApi();
    await expect(api.updateTask(demoProjectId, demoTaskId, { status: "done", expectedVersion: -1 })).rejects.toMatchObject({
      status: 409,
      apiError: { code: "VERSION_CONFLICT", message: "This task changed while you were editing it.", details: expect.any(Object) },
    });
  });

  it("supports required project creation and task deletion workflows", async () => {
    const api = new MockWorkspaceApi();
    const project = await api.createProject("Delivery readiness", "Track the final submission path.");
    const task = await api.createTask(project.id, "Rehearse the live demo");
    const deleted = await api.deleteTask(project.id, task.id, task.version);

    expect(project.name).toBe("Delivery readiness");
    expect(deleted).toEqual({ id: task.id, deleted: true, version: task.version + 1 });
    await expect(api.getTask(project.id, task.id)).rejects.toMatchObject({ status: 404 });
  });

  it("searches active members and records assign and unassign history", async () => {
    const api = new MockWorkspaceApi();
    const project = await api.createProject("Membership lifecycle", "Exercise assignment history.");
    const task = await api.createTask(project.id, "Choose a clear owner");
    const members = await api.listMembers(project.id, { search: "Avery", status: "ACTIVE", limit: 2 });
    const member = members.items[0];

    const assigned = await api.updateTask(project.id, task.id, { assigneeIds: [member.id], expectedVersion: task.version });
    await api.updateTask(project.id, task.id, { assigneeIds: [], expectedVersion: assigned.version });
    const history = await api.listAssignmentHistory(project.id, task.id);

    expect(members.items).toHaveLength(1);
    expect(history.items.map((item) => item.operation)).toEqual(["UNASSIGNED", "ASSIGNED"]);
    expect(history.items.every((item) => item.userId === member.id)).toBe(true);
  });
});
