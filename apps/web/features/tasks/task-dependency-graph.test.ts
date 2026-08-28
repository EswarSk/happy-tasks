import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/api";
import { getTaskConnections } from "./task-dependency-graph";

const makeTask = (id: string, dependencyIds: string[] = []): Task => ({
  id,
  projectId: "project-1",
  key: id.toUpperCase(),
  title: id,
  description: "",
  status: "todo",
  priority: "medium",
  assigneeIds: [],
  tags: [],
  dependencyIds,
  blockingCount: 0,
  commentCount: 0,
  customFields: {},
  updatedAt: "2026-08-28T00:00:00.000Z",
  version: 1,
});

describe("getTaskConnections", () => {
  it("keeps upstream IDs visible and finds known downstream tasks", () => {
    const task = { ...makeTask("current", ["upstream", "outside-page"]), blockingCount: 2 };
    const connections = getTaskConnections(task, [makeTask("upstream"), makeTask("downstream", [task.id])]);

    expect(connections.dependencies.map((item) => typeof item === "string" ? item : item.id)).toEqual(["upstream", "outside-page"]);
    expect(connections.blockers.map((item) => item.id)).toEqual(["downstream"]);
    expect(connections.hiddenBlockers).toBe(1);
  });
});
