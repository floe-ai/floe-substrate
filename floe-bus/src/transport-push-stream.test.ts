import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InvalidTransportPushCursorError,
  TransportPushStreamStore,
  decodeTransportPushCursor,
} from "./transport-push-stream.js";

describe("transport push stream", () => {
  let db: DatabaseSync;
  let stream: TransportPushStreamStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    stream = new TransportPushStreamStore(db);
  });

  afterEach(() => db.close());

  it("persists an opaque ordered cursor and filters catch-up to one Workspace", () => {
    const first = stream.append({ workspace_id: "workspace:one", type: "changed", payload: { value: 1 } });
    stream.append({ workspace_id: "workspace:two", type: "changed", payload: { value: 2 } });
    const third = stream.append({ workspace_id: "workspace:one", type: "changed", payload: { value: 3 } });

    expect(first.cursor).not.toBe("1");
    expect(decodeTransportPushCursor(first.cursor)).toBe(1);
    expect(stream.listAfter({
      after_cursor: first.cursor,
      workspace_id: "workspace:one",
    })).toEqual([third]);
  });

  it("rejects a malformed cursor rather than falling back to a full replay", () => {
    expect(() => stream.listAfter({ after_cursor: "not-a-cursor" }))
      .toThrow(InvalidTransportPushCursorError);
  });

  it("advances a durable Bridge checkpoint only after an explicit monotonic acknowledgement", () => {
    const first = stream.append({ workspace_id: "workspace:one", type: "one", payload: {} });
    const second = stream.append({ workspace_id: "workspace:one", type: "two", payload: {} });

    expect(stream.getBridgeCheckpoint("bridge:desktop")).toBeNull();
    expect(stream.acknowledgeBridge("bridge:desktop", second.cursor)).toBe(second.cursor);
    expect(stream.acknowledgeBridge("bridge:desktop", first.cursor)).toBe(second.cursor);

    const reopened = new TransportPushStreamStore(db);
    expect(reopened.getBridgeCheckpoint("bridge:desktop")).toBe(second.cursor);
  });
});
