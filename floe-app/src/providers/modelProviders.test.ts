import { beforeEach, describe, expect, it, vi } from "vitest";

const listHostOperations = vi.hoisted(() => vi.fn());
const confirmAndInvokeHostOperation = vi.hoisted(() => vi.fn());

vi.mock("../bus-client/client.ts", () => ({
  listHostOperations,
  confirmAndInvokeHostOperation,
}));
vi.mock("../fs/workspaceFs.ts", () => ({ isTauri: () => true }));

import { disconnectModelProvider, type ModelProviderStatus } from "./modelProviders.ts";

const connected: ModelProviderStatus = {
  type: "provider_status",
  provider: "openai-codex",
  name: "ChatGPT",
  auth_name: "OpenAI (ChatGPT Plus/Pro)",
  connected: true,
  profile_id: "openai-codex-subscription",
  secret_ref_id: "secretref:chatgpt",
  credential_revision: "generation:3:resolved",
  models: [],
};

describe("provider credential lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listHostOperations.mockResolvedValue([{
      operation_id: "credential.revoke",
      operation_version: "1",
      input: { version: "1" },
      availability: { available: true },
    }]);
  });

  it("uses the discovered credential operation and exact current revision", async () => {
    confirmAndInvokeHostOperation.mockResolvedValue({
      confirmed: true,
      receipt: {
        refusal: null,
        result: { credential: { generation: 4, resolution: "unresolved" } },
      },
    });

    const result = await disconnectModelProvider(connected);

    expect(listHostOperations).toHaveBeenCalledWith("disconnect credential", {
      kind: "secret_ref",
      id: "secretref:chatgpt",
    });
    expect(confirmAndInvokeHostOperation).toHaveBeenCalledWith(expect.objectContaining({
      operation_id: "credential.revoke",
      operation_version: "1",
      input_schema_version: "1",
      target: { kind: "secret_ref", id: "secretref:chatgpt" },
      expected_resource_revision: "generation:3:resolved",
      input: {},
    }));
    expect(result).toMatchObject({
      confirmed: true,
      status: { connected: false, credential_revision: "generation:4:unresolved" },
    });
  });

  it("does not change the projected account when native confirmation is cancelled", async () => {
    confirmAndInvokeHostOperation.mockResolvedValue({ confirmed: false });
    await expect(disconnectModelProvider(connected)).resolves.toEqual({
      confirmed: false,
      status: connected,
    });
  });
});
