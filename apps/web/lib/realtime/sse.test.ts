import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse";

describe("SSE parser", () => {
  it("preserves partial frames and ignores heartbeats", () => {
    const parser = createSseParser();
    expect(parser.feed(": heartbeat\n\nid: 18\nevent: task.")).toEqual([]);
    expect(parser.feed("updated\ndata: {\"id\":\"task-1\"}\n\n")).toEqual([
      { id: "18", event: "task.updated", data: '{"id":"task-1"}' },
    ]);
  });

  it("joins multi-line data fields", () => {
    const parser = createSseParser();
    expect(parser.feed("event: note\ndata: one\ndata: two\n\n")[0]?.data).toBe("one\ntwo");
  });
});
