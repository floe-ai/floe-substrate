/**
 * Pushes a single debounced change signal when anything under a set of
 * folders changes. Built on recursive fs.watch (file events, not polling).
 */
import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

export type WatchedTree = Readonly<{
  dir: string;
  /** Decides whether a changed path (relative to `dir`, `/`-separated) matters. Defaults to all. */
  matters?: (relativePath: string) => boolean;
}>;

const IGNORED_SEGMENTS = new Set([".git", "node_modules"]);

export function watchTrees(trees: readonly WatchedTree[], onChange: () => void, debounceMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const signal = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
  };
  const watchers: FSWatcher[] = [];
  for (const tree of trees) {
    try {
      const watcher = watch(tree.dir, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename === null) return signal();
        const relativePath = filename.toString().split(sep).join("/");
        if (relativePath.split("/").some(segment => IGNORED_SEGMENTS.has(segment))) return;
        if (tree.matters && !tree.matters(relativePath)) return;
        signal();
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // A folder that does not exist yet is reported by the next reconcile, not watched.
    }
  }
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
