export interface MentionMatch {
  start: number;
  end: number;
  query: string;
}

export function mentionAtCursor(text: string, cursor: number): MentionMatch | undefined {
  const prefix = text.slice(0, cursor);
  const start = prefix.lastIndexOf("@");
  if (start < 0 || start > 0 && /[A-Za-z0-9._-]/.test(prefix[start - 1] ?? "")) return undefined;
  const query = prefix.slice(start + 1);
  return /^[A-Za-z0-9._-]*$/.test(query) ? { start, end: cursor, query } : undefined;
}

export function insertMention(text: string, match: MentionMatch, handle: string) {
  const value = `${text.slice(0, match.start)}@${handle} ${text.slice(match.end).replace(/^\s/, "")}`;
  return { value, cursor: match.start + handle.length + 2 };
}
