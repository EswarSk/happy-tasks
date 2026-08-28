import { describe, expect, it } from "vitest";
import type { Comment } from "@/lib/api";
import { buildCommentTree } from "./comment-tree";

const base = {
  projectId: "project-1",
  taskId: "task-1",
  authorId: "user-1",
  createdAt: "2026-08-28T00:00:00.000Z",
  version: 1,
};

function comment(id: string, parentId?: string): Comment {
  return { ...base, id, body: id, ...(parentId ? { parentId } : {}) };
}

describe("buildCommentTree", () => {
  it("nests replies while preserving sibling order", () => {
    const tree = buildCommentTree([
      comment("root"),
      comment("reply-1", "root"),
      comment("reply-2", "root"),
      comment("nested", "reply-1"),
    ]);

    expect(tree.map((item) => item.id)).toEqual(["root"]);
    expect(tree[0]?.children.map((item) => item.id)).toEqual(["reply-1", "reply-2"]);
    expect(tree[0]?.children[0]?.children[0]?.id).toBe("nested");
  });

  it("keeps a reply visible while its older parent is not loaded", () => {
    expect(buildCommentTree([comment("reply", "older-parent")]).map((item) => item.id)).toEqual(["reply"]);
  });

  it("does not hide malformed cycles", () => {
    expect(buildCommentTree([comment("one", "two"), comment("two", "one")])).toHaveLength(2);
  });
});
