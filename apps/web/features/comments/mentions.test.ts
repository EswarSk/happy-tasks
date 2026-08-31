import { describe, expect, it } from "vitest";
import { insertMention, mentionAtCursor } from "./mentions";

describe("comment mentions", () => {
  it("finds and replaces the mention at the cursor", () => {
    const text = "Please ask @may about this";
    const match = mentionAtCursor(text, 15);
    expect(match).toEqual({ start: 11, end: 15, query: "may" });
    expect(insertMention(text, match!, "maya")).toEqual({ value: "Please ask @maya about this", cursor: 17 });
  });

  it("does not treat email addresses as mentions", () => {
    expect(mentionAtCursor("maya@example", 12)).toBeUndefined();
  });
});
