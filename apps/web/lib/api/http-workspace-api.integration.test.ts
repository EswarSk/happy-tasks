import { describe, expect, it } from "vitest";
import { HttpWorkspaceApi } from "./http-workspace-api";

const baseUrl = process.env.TEST_API_BASE_URL;

describe.skipIf(!baseUrl)("HttpWorkspaceApi live contract", () => {
  it("runs the required project, task, dependency, and comment flow", async () => {
    const api = new HttpWorkspaceApi(baseUrl!);
    const project = await api.createProject(`Contract test ${crypto.randomUUID().slice(0, 8)}`, "Disposable API adapter verification.");
    const first = await api.createTask(project.id, "Prove the browser API contract");
    const second = await api.createTask(project.id, "Provide a dependency target");

    const updated = await api.updateTask(project.id, first.id, {
      status: "in_progress",
      priority: "high",
      expectedVersion: first.version,
    });
    const dependency = await api.addDependency(project.id, first.id, second.id);
    const comment = await api.createComment(project.id, first.id, "The real Go API accepted this browser-shaped flow.", crypto.randomUUID());
    const reply = await api.createComment(project.id, first.id, "The threaded reply kept its parent relationship.", crypto.randomUUID(), comment.id);
    const comments = await api.listComments(project.id, first.id);
    const removed = await api.removeDependency(project.id, first.id, second.id);
    const deleted = await api.deleteTask(project.id, first.id, updated.version);

    expect((await api.listProjects()).some((item) => item.id === project.id)).toBe(true);
    expect(updated.status).toBe("in_progress");
    expect(dependency.dependsOnTaskId).toBe(second.id);
    expect(comments.items.some((item) => item.id === comment.id)).toBe(true);
    expect(comments.items.find((item) => item.id === reply.id)?.parentId).toBe(comment.id);
    expect(removed.deleted).toBe(true);
    expect(deleted.deleted).toBe(true);
  }, 15_000);
});
