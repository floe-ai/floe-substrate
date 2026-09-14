import { afterEach, describe, expect, it, vi } from "vitest";
import { FloeHttpError, startupFailure, waitForFloe } from "./startup.ts";

afterEach(() => vi.useRealTimers());

describe("Floe startup", () => {
  it.each([401, 403, 404, 429])("does not retry a %s response or describe it as a stopped service", async status => {
    const error = new FloeHttpError(status, "/v1/local/workspaces");
    const load = vi.fn().mockRejectedValue(error);
    await expect(waitForFloe(load)).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
    expect(startupFailure(error).detail).not.toMatch(/stuck|restart|unavailable/);
    expect(startupFailure(error).needsConnection).toBe(status === 401);
  });

  it("waits for a starting service and recovers", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue("ready");
    const result = waitForFloe(load);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("ready");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
