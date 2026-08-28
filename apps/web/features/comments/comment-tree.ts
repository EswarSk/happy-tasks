import type { Comment } from "@/lib/api";

export interface CommentNode extends Comment {
  children: CommentNode[];
}

/**
 * Builds a stable forest without changing API order. A reply whose parent has
 * not been loaded yet remains visible as a root and moves into place when an
 * older page supplies its parent.
 */
export function buildCommentTree(comments: Comment[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>(comments.map((comment) => [comment.id, { ...comment, children: [] }]));
  const roots: CommentNode[] = [];

  for (const comment of comments) {
    const node = nodes.get(comment.id)!;
    const parent = comment.parentId ? nodes.get(comment.parentId) : undefined;
    if (!parent || createsCycle(node, parent, nodes)) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  return roots;
}

function createsCycle(node: CommentNode, parent: CommentNode, nodes: Map<string, CommentNode>) {
  let current: CommentNode | undefined = parent;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === node.id) return true;
    visited.add(current.id);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return false;
}
