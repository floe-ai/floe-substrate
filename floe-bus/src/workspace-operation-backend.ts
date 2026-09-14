import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { BusStore } from "./store.js";
import {
  WorkspaceDirectoryNotFoundError,
  type WorkspaceOperationBackend,
} from "./workspace-operations.js";
import { WorkspaceLocatorInvalidError } from "./workspace-identities.js";

type Broadcast = (type: string, payload?: Record<string, unknown>) => void;

/** Bus adapter shared by semantic Workspace operations and local bootstrap UI. */
export class BusWorkspaceOperationBackend implements WorkspaceOperationBackend {
  constructor(
    private readonly store: BusStore,
    private readonly broadcast: Broadcast,
  ) {}

  inspect(workspaceId: string) {
    return this.store.getRemoteWorkspace(workspaceId);
  }

  register(input: Parameters<WorkspaceOperationBackend["register"]>[0]) {
    if (!isAbsolute(input.locator)) {
      throw new WorkspaceLocatorInvalidError(
        this.store.localWorkspacePlatform,
        "an absolute path is required",
      );
    }
    const locator = resolve(input.locator);
    if (!existsSync(locator)) {
      if (!input.create_directory) throw new WorkspaceDirectoryNotFoundError(locator);
      mkdirSync(locator, { recursive: true });
    }
    const workspace = this.store.registerWorkspace({ ...input, locator }, this.broadcast);
    return this.requireRemote(workspace.workspace_id);
  }

  rebind(input: Parameters<WorkspaceOperationBackend["rebind"]>[0]) {
    const workspace = this.store.rebindWorkspace(input, this.broadcast);
    return this.requireRemote(workspace.workspace_id);
  }

  restore(input: Parameters<WorkspaceOperationBackend["restore"]>[0]) {
    const workspace = this.store.restoreWorkspaceIdentity(input, this.broadcast);
    return this.requireRemote(workspace.workspace_id);
  }

  derive(input: Parameters<WorkspaceOperationBackend["derive"]>[0]) {
    const workspace = this.store.deriveWorkspaceIdentity(input, this.broadcast);
    return this.requireRemote(workspace.workspace_id);
  }

  private requireRemote(workspaceId: string) {
    const workspace = this.store.getRemoteWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace identity disappeared after operation: ${workspaceId}`);
    return workspace;
  }
}
