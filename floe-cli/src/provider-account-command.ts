import { randomBytes } from "node:crypto";

import {
  CliOperationClient,
  NativeCliOperationAuthorityBroker,
  type CliOperationAuthorityBroker,
  type CliProviderAccount,
  type OperationConfirmation,
} from "./operation-client.js";

export type ProviderAccountBroker = CliOperationAuthorityBroker & Readonly<{
  listProviderAccounts(): Promise<CliProviderAccount[]>;
}>;

export type DisconnectProviderAccountResult =
  | Readonly<{ kind: "cancelled"; account: CliProviderAccount }>
  | Readonly<{ kind: "already_disconnected"; account: CliProviderAccount }>
  | Readonly<{ kind: "disconnected"; account: CliProviderAccount }>;

export async function disconnectProviderAccount(
  providerId: string,
  options: Readonly<{
    broker?: ProviderAccountBroker;
    confirm: (confirmation: OperationConfirmation) => Promise<boolean>;
    idempotency_key?: string;
  }>,
): Promise<DisconnectProviderAccountResult> {
  const provider = requireText(providerId, "provider id");
  const broker = options.broker ?? new NativeCliOperationAuthorityBroker();
  const account = (await broker.listProviderAccounts())
    .find((candidate) => candidate.provider_id === provider);
  if (!account) {
    throw new Error(`Provider '${provider}' is not configured in Floe.`);
  }
  if (!account.connected) return { kind: "already_disconnected", account };

  const result = await new CliOperationClient(broker).invokeSelected({
    boundary: { kind: "host" },
    operation_id: "credential.revoke",
    target: { kind: "secret_ref", id: account.secret_ref_id },
    expected_resource_revision: `generation:${account.generation}:resolved`,
    idempotency_key: options.idempotency_key
      ?? `provider-disconnect:${randomBytes(18).toString("base64url")}`,
    input: {},
    confirm: options.confirm,
  });
  if (isRecord(result) && result.kind === "cancelled") {
    return { kind: "cancelled", account };
  }

  const receipt = isRecord(result) && isRecord(result.receipt) ? result.receipt : null;
  if (!receipt) throw new Error("Floe returned an invalid provider disconnection result.");
  if (isRecord(receipt.refusal) && typeof receipt.refusal.message === "string") {
    throw new Error(receipt.refusal.message);
  }
  const credential = isRecord(receipt.result) && isRecord(receipt.result.credential)
    ? receipt.result.credential
    : null;
  if (
    !credential
    || typeof credential.generation !== "number"
    || credential.resolution !== "unresolved"
  ) {
    throw new Error("Floe disconnected the account but did not return its current status.");
  }
  return {
    kind: "disconnected",
    account: { ...account, connected: false, generation: credential.generation },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: string, label: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}
