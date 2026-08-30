import { describe, expect, it } from "vitest";
import { taskCollaborators, type CollaboratorPresence } from "./use-project-presence";

describe("taskCollaborators", () => {
  it("shows unique other actors only on the active task", () => {
    const peers: CollaboratorPresence[] = [
      { sessionId: "browser-a", actorId: "maya", taskId: "task-1" },
      { sessionId: "browser-b", actorId: "maya", taskId: "task-1" },
      { sessionId: "browser-c", actorId: "noah", taskId: "task-1" },
      { sessionId: "browser-d", actorId: "priya", taskId: "task-2" },
    ];

    expect(taskCollaborators(peers, "task-1", "noah")).toEqual([
      { sessionId: "browser-b", actorId: "maya", taskId: "task-1" },
    ]);
  });
});
