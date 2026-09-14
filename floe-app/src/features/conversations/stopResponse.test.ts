import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResponseStop } from "./stopResponse.ts";
import { invokeOperation, listOperations } from "../../bus-client/client.ts";
vi.mock("../../bus-client/client.ts", () => ({ invokeOperation: vi.fn(), listOperations: vi.fn() }));

describe("stop response confirmation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listOperations).mockResolvedValue([{ operation_id: "runtime.delivery.cancel", operation_version: "2",
      input: { version: "3" }, availability: { available: true } }] as any);
  });
  it("reuses one exact request after uncertain transmission and takes versions from discovery", async () => {
    vi.mocked(invokeOperation).mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValueOnce({ state: "completed" } as any);
    const stop = createResponseStop("workspace:test", "del:one");
    await expect(stop()).rejects.toThrow("not confirmed Stop");
    await stop();
    expect(vi.mocked(invokeOperation).mock.calls[1]).toEqual(vi.mocked(invokeOperation).mock.calls[0]);
    expect(vi.mocked(invokeOperation).mock.calls[0][1]).toMatchObject({ operation_version: "2", input_schema_version: "3", target: { kind: "runtime_delivery", id: "del:one" } });
    expect(listOperations).toHaveBeenCalledTimes(1);
  });
  it("does not claim success for refusal or unfinished cancellation", async () => {
    const stop = createResponseStop("workspace:test", "del:one");
    vi.mocked(invokeOperation).mockResolvedValueOnce({ state: "refused", refusal: { message: "Authority was revoked" } } as any);
    await expect(stop()).rejects.toThrow("Authority was revoked");
    vi.mocked(invokeOperation).mockResolvedValueOnce({ state: "accepted" } as any);
    await expect(stop()).rejects.toThrow("not confirmed Stop");
  });
});
