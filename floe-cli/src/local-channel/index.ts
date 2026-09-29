/**
 * The service side of a Floe local channel, for Floe's own services outside
 * floe-cli (the Bridge's engine control). Surface libraries use connect.ts and
 * client.ts, which need the CLI's config and startup.
 */
export * from "./protocol.js";
export * from "./server.js";
export * from "./connection.js";
