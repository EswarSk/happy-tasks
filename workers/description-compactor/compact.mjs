import * as Y from "yjs";

export function mergeDescription(snapshot, updates) {
  const document = new Y.Doc();
  Y.applyUpdate(document, snapshot);
  for (const update of updates) Y.applyUpdate(document, update);
  return {
    snapshot: Buffer.from(Y.encodeStateAsUpdate(document)),
    text: document.getText("description").toString(),
  };
}
