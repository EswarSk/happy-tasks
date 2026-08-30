import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { mergeDescription } from "./compact.mjs";

test("merges deltas into one reconnectable snapshot", () => {
  const source = new Y.Doc();
  const text = source.getText("description");
  const initial = Y.encodeStateAsUpdate(source);
  let delta;
  source.on("update", (update) => { delta = update; });
  text.insert(0, "distributed description");

  const compacted = mergeDescription(initial, [delta]);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, compacted.snapshot);

  assert.equal(compacted.text, "distributed description");
  assert.equal(restored.getText("description").toString(), compacted.text);
});
