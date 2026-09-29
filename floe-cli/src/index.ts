#!/usr/bin/env node
/**
 * @invariant Cell: floe-cli.cli-process-manager
 * @invariant Module: floe-cli.cli-process-manager.main
 * @invariant Owns the process-level terminal boundary for every Floe command.
 * @invariant Only this boundary converts an unhandled command failure into terminal output.
 * @invariant Unhandled failures must pass through cli-error before the process exits.
 * @invariant Do not print rejected errors directly or allow Node to print their stack by default.
 * @invariant Update this block in the same turn when the structural contract changes.
 */
import { printCliFailure, reportCliFailure } from "./cli-error.js";

try {
  const { runCli } = await import("./cli.js");
  await runCli(process.argv);
} catch (error) {
  printCliFailure(reportCliFailure(error, {
    argv: process.argv,
    debug: process.argv.includes("--debug"),
  }));
  process.exitCode = 1;
}
