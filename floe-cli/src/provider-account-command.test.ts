import { describe, expect, it, vi } from "vitest";

import { disconnectProviderAccount, type ProviderAccountBroker } from "./provider-account-command.js";
import type { CliOperationDescriptor } from "./operation-client.js";

const revoke: CliOperationDescriptor = {
  operation_id: "credential.revoke",
  operation_version: "1",
  category: "credentials",
  title: "Disconnect Credential",
  description: "Remove protected credential material.",
  effects: { mode: "write" },
  target: { resource_kinds: ["secret_ref"], expected_revision: "required" },
  input: { version: "1", schema: { type: "object" } },
  result: { version: "1", schema: { type: "object" } },
  interaction_constraints: {
    confirmation: {
      required: true,
      prompt_id: "credential.revoke.confirm",
      title: "Disconnect this credential?",
      description: "Work using this credential will remain blocked until it is connected again.",
    },
  },
  availability: { available: true },
};

function broker(connected = true): ProviderAccountBroker & {
  confirmAndInvokeHostOperation: ReturnType<typeof vi.fn>;
} {
  return {
    listProviderAccounts: vi.fn(async () => [{
      provider_id: "openai-codex",
      secret_ref_id: "secret-ref:codex",
      connected,
      generation: 4,
    }]),
    listLocalWorkspaces: vi.fn(async () => ({ workspaces: [] })),
    discoverOperations: vi.fn(async () => ({ operations: [revoke] })),
    invokeOperation: vi.fn(async () => { throw new Error("ordinary invocation must not be used"); }),
    confirmAndInvokeHostOperation: vi.fn(async () => ({
      kind: "receipt",
      receipt: {
        state: "completed",
        result: { credential: { generation: 5, resolution: "unresolved" } },
      },
    })),
    confirmAndInvokeWorkspaceOperation: vi.fn(async () => {
      throw new Error("Workspace confirmation must not be used");
    }),
  };
}

describe("CLI provider disconnection", () => {
  it("uses the discovered host operation and the Bus-owned confirmation", async () => {
    const authority = broker();
    const confirm = vi.fn(async () => true);

    await expect(disconnectProviderAccount("openai-codex", {
      broker: authority,
      confirm,
      idempotency_key: "disconnect:test",
    })).resolves.toEqual({
      kind: "disconnected",
      account: {
        provider_id: "openai-codex",
        secret_ref_id: "secret-ref:codex",
        connected: false,
        generation: 5,
      },
    });

    expect(confirm).toHaveBeenCalledWith(revoke.interaction_constraints.confirmation);
    expect(authority.confirmAndInvokeHostOperation).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        operation_id: "credential.revoke",
        target: { kind: "secret_ref", id: "secret-ref:codex" },
        expected_resource_revision: "generation:4:resolved",
        idempotency_key: "disconnect:test",
      }),
    }));
  });

  it("does nothing when the account is already disconnected", async () => {
    const authority = broker(false);
    await expect(disconnectProviderAccount("openai-codex", {
      broker: authority,
      confirm: async () => true,
    })).resolves.toMatchObject({ kind: "already_disconnected" });
    expect(authority.confirmAndInvokeHostOperation).not.toHaveBeenCalled();
  });

  it("does nothing when the operator declines", async () => {
    const authority = broker();
    await expect(disconnectProviderAccount("openai-codex", {
      broker: authority,
      confirm: async () => false,
    })).resolves.toMatchObject({ kind: "cancelled" });
    expect(authority.confirmAndInvokeHostOperation).not.toHaveBeenCalled();
  });
});
