/**
 * Todo extension — workspace-local task tracking.
 *
 * State is persisted to `{workspacePath}/.floe/state/todo.json`.
 * Exposes four tools: add, list, update, remove.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done";
  created_at: string;
  updated_at: string;
}

type ExtensionHookName =
  | "SessionStart"
  | "BeforeTurn"
  | "TurnEnd"
  | "Error"
  | "WebhookReceived";

interface ExtensionContext {
  workspacePath: string;
  busClient: any;
  workspaceId: string;
  extensionName: string;
  hooks: {
    on(hook: ExtensionHookName, handler: (payload: Record<string, unknown>) => void): void;
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

// ── State helpers ───────────────────────────────────────────────────────────

function statePath(workspacePath: string): string {
  return join(workspacePath, ".floe", "state", "todo.json");
}

function loadItems(workspacePath: string): TodoItem[] {
  const p = statePath(workspacePath);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as TodoItem[];
  } catch {
    return [];
  }
}

function saveItems(workspacePath: string, items: TodoItem[]): void {
  const p = statePath(workspacePath);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(items, null, 2), "utf-8");
}

function nextId(items: TodoItem[]): string {
  let max = 0;
  for (const item of items) {
    const match = item.id.match(/^t-(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return `t-${max + 1}`;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export default function createTodoTools(ctx: ExtensionContext) {
  const { workspacePath } = ctx;

  // Register a TurnEnd hook (proves hook wiring works)
  ctx.hooks.on("TurnEnd", () => {});

  return [
    // ── add ───────────────────────────────────────────────────────────────
    {
      name: "add",
      label: "Add Todo",
      description: "Add a new todo item",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Description of the todo item" },
        },
        required: ["text"],
      },
      async execute(_callId: string, params: Record<string, unknown>): Promise<ToolResult> {
        const text = params.text as string;
        if (!text || typeof text !== "string") {
          return {
            content: [{ type: "text", text: "Error: 'text' parameter is required" }],
            details: { error: true },
          };
        }
        const items = loadItems(workspacePath);
        const now = new Date().toISOString();
        const item: TodoItem = {
          id: nextId(items),
          text,
          status: "pending",
          created_at: now,
          updated_at: now,
        };
        items.push(item);
        saveItems(workspacePath, items);
        return {
          content: [{ type: "text", text: `Created todo ${item.id}: "${item.text}"` }],
          details: { item },
        };
      },
    },

    // ── list ──────────────────────────────────────────────────────────────
    {
      name: "list",
      label: "List Todos",
      description: "List todo items, optionally filtered by status",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "in_progress", "done"],
            description: "Filter by status",
          },
        },
      },
      async execute(_callId: string, params: Record<string, unknown>): Promise<ToolResult> {
        let items = loadItems(workspacePath);
        const status = params.status as string | undefined;
        if (status) {
          items = items.filter((i) => i.status === status);
        }
        return {
          content: [{ type: "text", text: items.length === 0 ? "No items found" : JSON.stringify(items, null, 2) }],
          details: { items, count: items.length },
        };
      },
    },

    // ── update ─────────────────────────────────────────────────────────────
    {
      name: "update",
      label: "Update Todo",
      description: "Update a todo item's text or status",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Todo item ID" },
          text: { type: "string", description: "New description" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "done"],
            description: "New status",
          },
        },
        required: ["id"],
      },
      async execute(_callId: string, params: Record<string, unknown>): Promise<ToolResult> {
        const id = params.id as string;
        const items = loadItems(workspacePath);
        const item = items.find((i) => i.id === id);
        if (!item) {
          return {
            content: [{ type: "text", text: `Error: no todo with id "${id}"` }],
            details: { error: true },
          };
        }
        if (typeof params.text === "string") item.text = params.text;
        if (typeof params.status === "string") {
          item.status = params.status as TodoItem["status"];
        }
        item.updated_at = new Date().toISOString();
        saveItems(workspacePath, items);
        return {
          content: [{ type: "text", text: `Updated todo ${item.id}: status=${item.status}` }],
          details: { item },
        };
      },
    },

    // ── remove ─────────────────────────────────────────────────────────────
    {
      name: "remove",
      label: "Remove Todo",
      description: "Remove a todo item",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Todo item ID to remove" },
        },
        required: ["id"],
      },
      async execute(_callId: string, params: Record<string, unknown>): Promise<ToolResult> {
        const id = params.id as string;
        const items = loadItems(workspacePath);
        const idx = items.findIndex((i) => i.id === id);
        if (idx === -1) {
          return {
            content: [{ type: "text", text: `Error: no todo with id "${id}"` }],
            details: { error: true },
          };
        }
        const [removed] = items.splice(idx, 1);
        saveItems(workspacePath, items);
        return {
          content: [{ type: "text", text: `Removed todo ${removed.id}: "${removed.text}"` }],
          details: { removed },
        };
      },
    },
  ];
}
