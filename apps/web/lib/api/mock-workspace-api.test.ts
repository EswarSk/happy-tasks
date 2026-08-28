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

  it("filters tasks by assignee and tag", async () => {
    const api = new MockWorkspaceApi();
    const all = await api.listTasks(demoProjectId, { limit: 100 });
    const assigned = all.items.find((task) => task.assigneeIds.length && task.tags.length);
    expect(assigned).toBeDefined();
    const byAssignee = await api.listTasks(demoProjectId, { assigneeId: assigned!.assigneeIds[0], limit: 100 });
    const byTag = await api.listTasks(demoProjectId, { tag: assigned!.tags[0], limit: 100 });
    expect(byAssignee.items.every((task) => task.assigneeIds.includes(assigned!.assigneeIds[0]))).toBe(true);
    expect(byTag.items.every((task) => task.tags.some((tag) => tag.toLowerCase().includes(assigned!.tags[0].toLowerCase())))).toBe(true);
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

  it("creates nested replies and rejects parents from another task", async () => {
    const api = new MockWorkspaceApi();
    const project = await api.createProject("Threaded discussion", "Exercise reply relationships.");
    const firstTask = await api.createTask(project.id, "Discuss this task");
    const secondTask = await api.createTask(project.id, "Keep threads isolated");
    const root = await api.createComment(project.id, firstTask.id, "Root comment", crypto.randomUUID());
    const reply = await api.createComment(project.id, firstTask.id, "Nested reply", crypto.randomUUID(), root.id);
    const comments = await api.listComments(project.id, firstTask.id);

    expect(comments.items.find((item) => item.id === reply.id)?.parentId).toBe(root.id);
    await expect(api.createComment(project.id, secondTask.id, "Invalid reply", crypto.randomUUID(), root.id)).rejects.toMatchObject({
      status: 422,
      apiError: { code: "COMMENT_PARENT_NOT_FOUND" },
    });
  });

  it("toggles comment reactions and exposes project activity", async () => {
    const api = new MockWorkspaceApi();
    const comments = await api.listComments(demoProjectId, demoTaskId);
    const comment = comments.items[0];
    const added = await api.setCommentReaction(demoProjectId, demoTaskId, comment.id, "like");
    expect(added).toMatchObject({ commentId: comment.id, type: "like", count: 1, reacted: true });
    const refreshed = await api.listComments(demoProjectId, demoTaskId);
    expect(refreshed.items[0]?.reactions).toContainEqual(expect.objectContaining({ type: "like", count: 1, reacted: true }));
    await api.removeCommentReaction(demoProjectId, demoTaskId, comment.id);
    const activity = await api.listActivity(demoProjectId);
    expect(activity.items.some((item) => item.eventType === "comment.reaction.changed")).toBe(true);
  });
});
