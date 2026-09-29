/**
 * @invariant Cell: floe-bus.bus-store
 * @invariant Module: floe-bus.bus-store.main
 * @invariant Owns event-reactive test rendezvous for Bus tests.
 * @invariant Test waits resolve only when the observed producer pushes a matching event.
 * @invariant Timeouts are failure guards and must never drive repeated condition checks.
 * @invariant Do not add interval or retry-loop polling here.
 * @invariant Update this block in the same turn when the structural contract changes.
 */

export type TestPushFrame = {
  type: string;
  payload?: Record<string, any>;
  cursor?: string;
  at?: string;
};

type Waiter<T> = {
  predicate: (value: T) => boolean;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class EventProbe<T> {
  private readonly pending: T[] = [];
  private readonly waiters = new Set<Waiter<T>>();

  push(value: T): void {
    for (const waiter of this.waiters) {
      if (!waiter.predicate(value)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(value);
      return;
    }
    this.pending.push(value);
  }

  next(
    predicate: (value: T) => boolean,
    description: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    const index = this.pending.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.pending.splice(index, 1)[0]!);

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${description}.`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(reason = "Event probe closed."): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.waiters.clear();
  }
}

export async function openAuthenticatedPushStream(
  url: string,
  authentication: Record<string, unknown>,
): Promise<{
  socket: {
    close(): void;
    on(event: string, listener: (...args: any[]) => void): void;
    send(data: string): void;
  };
  frames: TestPushFrame[];
  events: EventProbe<TestPushFrame>;
}> {
  const wsModule = await import("ws" as any);
  const WebSocketConstructor = (wsModule as any).WebSocket ?? (wsModule as any).default;
  const socket = new WebSocketConstructor(url);
  const frames: TestPushFrame[] = [];
  const events = new EventProbe<TestPushFrame>();
  socket.on("message", (data: unknown) => {
    const frame = JSON.parse(String(data)) as TestPushFrame;
    frames.push(frame);
    events.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  socket.send(JSON.stringify({ type: "authenticate", ...authentication }));
  await events.next((frame) => frame.type === "caught_up", "transport caught_up");
  return { socket, frames, events };
}
