export interface ParsedSseEvent {
  id?: string;
  event?: string;
  data: string;
}

export function createSseParser() {
  let buffer = "";
  return {
    feed(chunk: string): ParsedSseEvent[] {
      buffer += chunk.replaceAll("\r\n", "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      return frames.flatMap((frame) => {
        let id: string | undefined;
        let event: string | undefined;
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const separator = line.indexOf(":");
          const field = separator === -1 ? line : line.slice(0, separator);
          const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
          if (field === "id") id = value;
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
        return data.length ? [{ id, event, data: data.join("\n") }] : [];
      });
    },
  };
}
