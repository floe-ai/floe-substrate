import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const RENDERER_PATTERN = /^[a-z][a-z0-9_-]*$/;

const ScopeProjectionLayoutIdSchema = z
  .string()
  .min(1)
  .max(200);

/**
 * The layout schema identity carries the client-supplied renderer, so any
 * client owns its own projection layout. The original single client wrote
 * `floe.scope-projection.layout.floe-app.v1`; the `floe-app` renderer still
 * derives exactly that string, so pre-existing floe-app layouts keep loading.
 */
export function scopeProjectionLayoutSchemaId(renderer: string): string {
  return `floe.scope-projection.layout.${renderer}.v1`;
}

/** A renderer identity a client may own its layout under. */
export function isValidRenderer(renderer: string): boolean {
  return RENDERER_PATTERN.test(renderer);
}

const ScopeProjectionLayoutViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number()
});

const ScopeProjectionLayoutItemsSchema = z.record(
  z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().optional(),
    height: z.number().optional(),
    collapsed: z.boolean().optional()
  })
);

function scopeProjectionLayoutSchema(renderer: string) {
  return z.object({
    schema: z.literal(scopeProjectionLayoutSchemaId(renderer)),
    scope_id: ScopeProjectionLayoutIdSchema,
    viewport: ScopeProjectionLayoutViewportSchema,
    items: ScopeProjectionLayoutItemsSchema
  });
}

export type ScopeProjectionLayout = {
  schema: string;
  scope_id: string;
  viewport: z.infer<typeof ScopeProjectionLayoutViewportSchema>;
  items: z.infer<typeof ScopeProjectionLayoutItemsSchema>;
};

export class ScopeProjectionLayoutValidationError extends Error {
  constructor(message: string, readonly issues?: z.ZodIssue[]) {
    super(message);
    this.name = "ScopeProjectionLayoutValidationError";
  }
}

export class ScopeProjectionLayoutIdMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeProjectionLayoutIdMismatchError";
  }
}

export class ScopeProjectionLayoutRendererInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeProjectionLayoutRendererInvalidError";
  }
}

function layoutsDir(workspacePath: string): string {
  return join(workspacePath, ".floe", "scope-projection-layouts");
}

function layoutPath(workspacePath: string, scopeId: string, renderer: string): string {
  return join(layoutsDir(workspacePath), `${encodeURIComponent(scopeId)}.layout.${renderer}.yaml`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function parseYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return YAML.parse(raw) as T;
}

function writeYamlFile(path: string, body: unknown): void {
  writeFileSync(path, YAML.stringify(body), "utf8");
}

function validateScopeId(scopeId: string): void {
  const parsed = ScopeProjectionLayoutIdSchema.safeParse(scopeId);
  if (!parsed.success) {
    throw new ScopeProjectionLayoutValidationError(
      `invalid scope id '${scopeId}': ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      parsed.error.issues
    );
  }
}

function validateRenderer(renderer: string): void {
  if (!isValidRenderer(renderer)) {
    throw new ScopeProjectionLayoutRendererInvalidError(
      `invalid renderer name '${renderer}': must match ^[a-z][a-z0-9_-]*$`
    );
  }
}

export function upsertScopeProjectionLayout(
  workspacePath: string,
  scopeId: string,
  renderer: string,
  body: unknown
): ScopeProjectionLayout {
  validateScopeId(scopeId);
  validateRenderer(renderer);

  const result = scopeProjectionLayoutSchema(renderer).safeParse(body);
  if (!result.success) {
    throw new ScopeProjectionLayoutValidationError(
      `invalid layout body for scope '${scopeId}' renderer '${renderer}': ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      result.error.issues
    );
  }
  const layout = result.data;

  if (layout.scope_id !== scopeId) {
    throw new ScopeProjectionLayoutIdMismatchError(
      `layout scope_id '${layout.scope_id}' does not match path scope id '${scopeId}'`
    );
  }

  const path = layoutPath(workspacePath, scopeId, renderer);
  ensureDir(layoutsDir(workspacePath));
  writeYamlFile(path, layout);
  return layout;
}

export function loadScopeProjectionLayout(
  workspacePath: string,
  scopeId: string,
  renderer: string
): ScopeProjectionLayout | null {
  validateScopeId(scopeId);
  validateRenderer(renderer);

  const path = layoutPath(workspacePath, scopeId, renderer);
  if (!existsSync(path)) return null;

  const parsed = parseYamlFile<unknown>(path);
  const result = scopeProjectionLayoutSchema(renderer).safeParse(parsed);
  if (!result.success) {
    throw new ScopeProjectionLayoutValidationError(
      `invalid layout file '${path}': ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      result.error.issues
    );
  }
  return result.data;
}
