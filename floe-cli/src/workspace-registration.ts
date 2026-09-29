/**
 * @invariant A folder Floe registers belongs to the person signed in on this
 * machine: when the identity agent holds an identity that can act without a
 * prompt, registration goes through it, so that person is admitted and their
 * access is what the Workspace's Actors act with. With nobody signed in, the
 * folder is registered through the host broker and the CLI says plainly that
 * its Actors have no access until a person joins.
 */
import { connectIdentity, type IdentityClient, type IdentityState, type JoinOutcome } from "./identity/client.js";
import { registerLocalWorkspaceViaBroker } from "./operation-client.js";

export const NO_PERSON_NOTE =
  "Nobody is signed in on this machine, so Floe opened this folder without a person.\n"
  + "If nobody has joined this workspace yet, its Floe Actor has no access until someone does:\n"
  + "  floe identity create --name <your name>   (or: floe identity unlock)\n"
  + "  floe identity join";

type Dependencies = Readonly<{
  connect: () => Promise<IdentityClient>;
  register_via_broker: (locator: string) => Promise<unknown>;
  log: (line: string) => void;
}>;

export type FolderRegistration = Readonly<{ as: "person"; display_name: string; workspace_id: string } | { as: "host" }>;

/** True when the held identity can sign for the person without asking them anything. */
export function canActWithoutPrompt(state: IdentityState): state is Exclude<IdentityState, { kind: "none" }> {
  return state.kind === "unlocked" || (state.kind === "locked" && state.protection === "device");
}

export async function registerFolder(locator: string, deps: Dependencies): Promise<FolderRegistration> {
  const person = await joinAsPerson(locator, deps);
  if (person) return person;
  await deps.register_via_broker(locator);
  deps.log(NO_PERSON_NOTE);
  return { as: "host" };
}

async function joinAsPerson(locator: string, deps: Dependencies): Promise<FolderRegistration | null> {
  let client: IdentityClient;
  try {
    client = await deps.connect();
  } catch {
    return null;
  }
  try {
    const state = client.state;
    if (!canActWithoutPrompt(state)) return null;
    const outcome = await client.joinFolder({ locator });
    if (outcome.kind === "ready" || outcome.kind === "pending") {
      return { as: "person", display_name: state.display_name, workspace_id: outcome.workspace_id };
    }
    throw new Error(describeRefusal(locator, outcome));
  } finally {
    client.close();
  }
}

function describeRefusal(locator: string, outcome: JoinOutcome): string {
  if (outcome.kind === "failed") return `The workspace for ${locator} could not be prepared (${outcome.reason}).`;
  return "message" in outcome ? outcome.message : `The folder ${locator} could not be joined.`;
}

/** The production wiring: the identity agent is never started just to register a folder. */
export function defaultRegistrationDependencies(configPath: string | undefined, busHttpBase: string): Dependencies {
  return {
    connect: () => connectIdentity({ surface: "floe terminal", configPath, start: false }),
    register_via_broker: (locator) => registerLocalWorkspaceViaBroker(locator, true, busHttpBase),
    log: (line) => console.log(line),
  };
}
