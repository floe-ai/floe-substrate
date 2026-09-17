import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsTaskXml,
  installService,
  serviceStatus,
  uninstallService,
} from "./service.js";

describe("buildWindowsTaskXml", () => {
  it("scopes the trigger and principal to the given account and runs the given command", () => {
    const xml = buildWindowsTaskXml("ACME\\alice", "C:\\node.exe", '"C:\\floe\\index.js" --config "C:\\c.yaml" start', "C:\\floe");
    expect(xml).toContain("<LogonTrigger><Enabled>true</Enabled><UserId>ACME\\alice</UserId></LogonTrigger>");
    expect(xml).toContain("<UserId>ACME\\alice</UserId>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<Command>C:\\node.exe</Command>");
    expect(xml).toContain("<WorkingDirectory>C:\\floe</WorkingDirectory>");
  });

  it("xml-escapes account, command and arguments", () => {
    const xml = buildWindowsTaskXml("A&B\\o'brien", 'C:\\a"b.exe', 'x & y <z> "q"', "C:\\d");
    expect(xml).toContain("A&amp;B\\o&apos;brien");
    expect(xml).toContain("C:\\a&quot;b.exe");
    expect(xml).toContain("x &amp; y &lt;z&gt; &quot;q&quot;");
    // No raw ampersand or angle bracket survives inside the escaped values.
    expect(xml).not.toContain("A&B");
    expect(xml).not.toContain("<z>");
  });
});

describe("serviceStatus shape", () => {
  it("reports a platform and, off Windows, that auto-start is not built", () => {
    const status = serviceStatus();
    expect(status.platform).toBe(process.platform);
    if (process.platform !== "win32") {
      expect(status.supported).toBe(false);
      expect(status.installed).toBe(false);
      expect(status.detail).toContain("not built");
    } else {
      expect(status.supported).toBe(true);
    }
  });
});

describe("non-Windows install is honest, not a stub", () => {
  it.skipIf(process.platform === "win32")("refuses and explains rather than reporting success", () => {
    const result = installService("C:\\c.yaml", { command: process.execPath, prefixArgs: ["x"], workingDirectory: "C:\\d" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not built");
  });
});

// A genuine round-trip against the real Task Scheduler, using a throwaway task
// name so it never touches a person's real Floe auto-start. Needs no admin.
describe.skipIf(process.platform !== "win32")("windows scheduled task round-trip", () => {
  const taskName = `FloeSubstrateTest-${process.pid}`;
  afterEach(() => uninstallService(taskName));

  it("installs, reports installed, then uninstalls", () => {
    expect(serviceStatus(taskName).installed).toBe(false);

    const installed = installService(
      "C:\\Users\\test\\.floe\\config.yaml",
      { command: process.execPath, prefixArgs: ["C:\\floe\\dist\\index.js"], workingDirectory: "C:\\floe\\dist" },
      taskName,
    );
    expect(installed.ok, installed.message).toBe(true);
    expect(serviceStatus(taskName).installed).toBe(true);

    const removed = uninstallService(taskName);
    expect(removed.ok, removed.message).toBe(true);
    expect(serviceStatus(taskName).installed).toBe(false);
  });

  it("uninstall is idempotent when nothing is installed", () => {
    const removed = uninstallService(taskName);
    expect(removed.ok).toBe(true);
  });
});
