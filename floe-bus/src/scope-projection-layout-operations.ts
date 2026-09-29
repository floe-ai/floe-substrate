import {
  isValidRenderer,
  loadScopeProjectionLayout,
  upsertScopeProjectionLayout,
  type ScopeProjectionLayout,
} from "./scope-projection-layout-store.js";
import { refusal, requireWorkspaceAuthorityId, type SemanticOperationDefinition } from "./operations.js";

export const SCOPE_PROJECTION_LAYOUT_OPERATION_IDS = [
  "scope.projection.layout.get",
  "scope.projection.layout.save",
] as const;

/** Maps each layout error to the refusal a client sees. */
const LAYOUT_REFUSALS: Record<string, string> = {
  ScopeProjectionLayoutValidationError: "scope_projection_layout_validation_error",
  ScopeProjectionLayoutIdMismatchError: "scope_projection_layout_id_mismatch",
  ScopeProjectionLayoutRendererInvalidError: "scope_projection_layout_renderer_invalid",
};
export const SCOPE_PROJECTION_LAYOUT_INVALID_CODES: readonly string[] = Object.values(LAYOUT_REFUSALS);

type Dependencies = Readonly<{
  scopeExists: (workspaceId: string, scopeId: string) => boolean;
  locator: (workspaceId: string) => string | null;
  broadcast: (type: string, payload: Record<string, unknown>) => void;
}>;

const text = { type: "string", minLength: 1 } as const;
// The name rule (^[a-z][a-z0-9_-]*$) is checked by the handler so a caller gets the precise refusal.
const renderer = { ...text,
  description: "The surface that owns this layout, for example star-map. Lowercase letters, digits, - and _, starting with a letter. Each surface keeps its own." } as const;
const layoutSchema = { type: "object", required: ["schema", "scope_id", "viewport", "items"], properties: {
  schema: { ...text, description: "floe.scope-projection.layout.<renderer>.v1" },
  scope_id: text,
  viewport: { type: "object" },
  items: { type: "object" },
} } as const;

/**
 * Where a surface places a Scope's nodes. A layout is presentation stored with
 * the Workspace's files, so any session that may act in the Workspace can read
 * and save it; it carries no authority over the Scope itself.
 */
export function scopeProjectionLayoutOperations(deps: Dependencies): SemanticOperationDefinition<any, any>[] {
  const common = {
    operation_version: "1", authority_boundary_kinds: ["workspace"] as const, category: "scopes",
    interaction_constraints: { allowed_modes: ["interactive", "unattended"] as const },
    target: { resource_kinds: [], expected_revision: "not_applicable" as const },
  };
  const input = (extra: Record<string, unknown> = {}) => ({ version: "1", schema: {
    type: "object", additionalProperties: false, required: ["scope_id", "renderer", ...Object.keys(extra)],
    properties: { scope_id: text, renderer, ...extra },
  } });
  const refused = (code: string, message: string) => ({ state: "refused" as const, refusal: refusal(code, message, false, null) });
  /** Resolves where this Workspace's layouts live, or the refusal a client should see. */
  const place = (workspaceId: string, scopeId: string, rendererId: string) => {
    if (!isValidRenderer(rendererId)) {
      return refused("scope_projection_layout_renderer_invalid", `renderer '${rendererId}' is not a valid renderer identity`);
    }
    if (!deps.scopeExists(workspaceId, scopeId)) return refused("scope_not_found", `No Scope '${scopeId}' in this Workspace.`);
    const locator = deps.locator(workspaceId);
    return locator ?? refused("workspace_local_binding_not_found", "This Workspace has no folder on this machine.");
  };
  const layoutError = (error: unknown) => {
    const code = error instanceof Error ? LAYOUT_REFUSALS[error.name] : undefined;
    if (!code) throw error;
    return refused(code, (error as Error).message);
  };

  return [{
    ...common, operation_id: "scope.projection.layout.get", required_grants: ["scope.projection.layout.get"],
    title: "Get a Scope's saved layout",
    description: "Read where a surface last placed this Scope's nodes and its viewport. The result is null when that surface has not saved a layout yet.",
    effects: { mode: "read", reversibility: "none", external: false, secret_access: "none" },
    input: input(),
    result: { version: "1", schema: { type: "object", additionalProperties: false, required: ["layout"],
      properties: { layout: { oneOf: [layoutSchema, { type: "null" }] } } } },
    handler: (context, value: { scope_id: string; renderer: string }) => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      const locator = place(workspaceId, value.scope_id, value.renderer);
      if (typeof locator !== "string") return locator;
      try {
        return { state: "completed", result: { layout: loadScopeProjectionLayout(locator, value.scope_id, value.renderer) } };
      } catch (error) {
        return layoutError(error);
      }
    },
  }, {
    ...common, operation_id: "scope.projection.layout.save", required_grants: ["scope.projection.layout.save"],
    title: "Save a Scope's layout",
    description: "Save where a surface places this Scope's nodes and its viewport, replacing that surface's previous layout. Other surfaces' layouts are untouched. Every connection in the Workspace is told it changed.",
    effects: { mode: "write", reversibility: "reversible", external: false, secret_access: "none" },
    input: input({ layout: { type: "object",
      description: "{schema: 'floe.scope-projection.layout.<renderer>.v1', scope_id, viewport: {x, y, zoom}, items: {<node id>: {x, y, width?, height?, collapsed?}}}" } }),
    result: { version: "1", schema: { type: "object", additionalProperties: false, required: ["layout"],
      properties: { layout: layoutSchema } } },
    handler: (context, value: { scope_id: string; renderer: string; layout: unknown }) => {
      const workspaceId = requireWorkspaceAuthorityId(context.authority);
      const locator = place(workspaceId, value.scope_id, value.renderer);
      if (typeof locator !== "string") return locator;
      let layout: ScopeProjectionLayout;
      try {
        layout = upsertScopeProjectionLayout(locator, value.scope_id, value.renderer, value.layout);
      } catch (error) {
        return layoutError(error);
      }
      deps.broadcast("scope_projection.layout.upserted", {
        workspace_id: workspaceId, scope_id: value.scope_id, source: "api", renderer: value.renderer,
      });
      return { state: "completed", result: { layout },
        audit_ref: { kind: "operation_invocation", id: context.invocation_id, revision: null } };
    },
  }];
}
