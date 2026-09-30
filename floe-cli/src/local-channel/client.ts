/**
 * The request/response and push plumbing every surface library on a Floe local
 * channel shares. A library subclasses it, adds its operations, and handles the
 * pushes it defines in onPush.
 */
import type { Channel } from "./connection.js";
import { ChannelUnavailableError } from "./connection.js";
import { versionNote } from "./connect.js";
import type { ChannelSpec } from "./protocol.js";
import { runningTurns, switchToThisVersion, type RunningTurn, type VersionSwitchOutcome } from "../version-switch.js";

export type { RunningTurn, VersionSwitchOutcome };

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export abstract class ChannelClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  protected constructor(
    protected readonly channel: Channel,
    private readonly spec: ChannelSpec,
    private readonly refusal: (code: string, message: string, details: Record<string, unknown>) => Error,
  ) {
    channel.onMessage((message) => this.receive(message));
    channel.socket.on("close", () => this.handleClose());
  }

  /** The Floe version of the process serving this channel. */
  get agentVersion(): string | null {
    return this.channel.agentVersion;
  }

  /**
   * Set when the serving process is a different Floe version from the copy this
   * surface depends on. Connect-first: it is used as is, never restarted.
   */
  get versionNote(): string | null {
    return versionNote(this.spec, this.channel.agentVersion);
  }

  /**
   * Ask Floe to run this surface's copy, which must be newer than the one
   * serving. It uses the same path as `floe restart`, and it never interrupts a
   * turn in progress unless `interrupt_running_work` is set: otherwise it
   * returns `work_running` naming the turns. After `switched`, this connection
   * has closed; connect again to reach the new version.
   */
  switchToThisVersion(options: { interrupt_running_work?: boolean } = {}): Promise<VersionSwitchOutcome> {
    return switchToThisVersion({ ...options, configPath: this.channel.configPath });
  }

  /** The Actors mid-turn right now, in every workspace: what a switch would interrupt. */
  runningTurns(): Promise<RunningTurn[]> {
    return runningTurns({ configPath: this.channel.configPath });
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.channel.socket.end();
  }

  /** A message the service pushed that is not a response. */
  protected abstract onPush(message: Record<string, unknown>): void;

  protected request<T = any>(op: string, args: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new ChannelUnavailableError("not_running", `The connection to ${this.spec.label} is closed.`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.send({ type: "request", id, op, args });
    });
  }

  private receive(message: Record<string, unknown>): void {
    if (message.type !== "response") {
      this.onPush(message);
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const { code, message: text, ...details } = (message.error ?? {}) as Record<string, unknown>;
    pending.reject(this.refusal(String(code ?? "failed"), String(text ?? `${this.spec.label} refused.`), details));
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new ChannelUnavailableError("not_running", `The connection to ${this.spec.label} closed.`));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
