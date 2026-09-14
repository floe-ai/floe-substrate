import type { BusStore } from "./store.js";
import type { OperationAuthorityVerification } from "./operation-authority-sessions.js";

export type HostControlAuthority = Readonly<{
  audience: "host_control";
  host_id: string;
  credential_id: string;
}>;

export type BridgeServiceAuthority = Readonly<{
  audience: "bridge_service";
  bridge_id: string;
  host_id: string;
  credential_id: string;
}>;

export type WorkspaceOperationAuthority = Readonly<{
  audience: "workspace_operation";
  workspace_id: string;
  authority_session_id: string;
  verification: Extract<OperationAuthorityVerification, { verified: true }>;
}>;

export type BusTransportAuthority =
  | HostControlAuthority
  | BridgeServiceAuthority
  | WorkspaceOperationAuthority;

export type BusTransportAuthFailure = Readonly<{
  verified: false;
  code: "transport_auth_required";
  message: "The transport credential was not accepted.";
}>;

export type BusTransportAuthResult =
  | Readonly<{ verified: true; authority: BusTransportAuthority }>
  | BusTransportAuthFailure;

type TransportAuthStore = Pick<
  BusStore,
  "localHostId" | "transportCredentialStore" | "operationAuthorityVerifier"
>;

/** One verifier for HTTP and WebSocket transports. Request content is absent. */
export class BusTransportAuthenticator {
  constructor(private readonly store: TransportAuthStore) {}

  authenticateHostControl(bearerToken: string): BusTransportAuthResult {
    const verified = this.store.transportCredentialStore.verifyHostControlBearerToken(bearerToken);
    if (!verified.verified || verified.credential.audience !== "host_control") return denied();
    if (verified.credential.host_id !== this.store.localHostId) return denied();
    return {
      verified: true,
      authority: {
        audience: "host_control",
        host_id: verified.credential.host_id,
        credential_id: verified.credential.transport_credential_id,
      },
    };
  }

  authenticateBridgeService(bearerToken: string): BusTransportAuthResult {
    const verified = this.store.transportCredentialStore.verifyBridgeServiceBearerToken(bearerToken);
    if (!verified.verified || verified.credential.audience !== "bridge_service") return denied();
    return {
      verified: true,
      authority: {
        audience: "bridge_service",
        bridge_id: verified.credential.bridge_id,
        host_id: verified.credential.host_id,
        credential_id: verified.credential.transport_credential_id,
      },
    };
  }

  authenticateWorkspaceOperation(
    bearerToken: string,
    workspaceId: string,
  ): BusTransportAuthResult {
    const verified = this.store.operationAuthorityVerifier.verifyBearerToken(bearerToken, {
      boundary: { kind: "workspace", workspace_id: workspaceId },
    });
    if (!verified.verified) return denied();
    return {
      verified: true,
      authority: {
        audience: "workspace_operation",
        workspace_id: workspaceId,
        authority_session_id: verified.authority_session_id,
        verification: verified,
      },
    };
  }
}

export function parseBearerHeader(authorization: string | undefined): string {
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization ?? "");
  return match?.[1] ?? "";
}

function denied(): BusTransportAuthFailure {
  return {
    verified: false,
    code: "transport_auth_required",
    message: "The transport credential was not accepted.",
  };
}
