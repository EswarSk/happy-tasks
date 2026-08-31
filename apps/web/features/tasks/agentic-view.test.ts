import { expect, it } from "vitest";
import { edgePath } from "./agentic-view";

it("connects persisted runtime node positions", () => {
  expect(edgePath({ positionX: 120, positionY: 240 }, { positionX: 450, positionY: 100 }))
    .toBe("M430 376 C480 376 480 236 530 236");
});
