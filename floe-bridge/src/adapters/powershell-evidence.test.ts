import { describe, expect, it } from "vitest";
import { powershellEvidence } from "./powershell-evidence.js";

const names = (command: string) => powershellEvidence(command).executables;

describe("PowerShell evidence", () => {
  it("names one executable per segment across every separator", () => {
    expect(names("git status")).toEqual(["git"]);
    expect(names("git status; npm test && node x.js || exit 1\nGet-ChildItem | Select-Object Name")).toEqual([
      "git", "npm", "node", "exit", "get-childitem", "select-object",
    ]);
    expect(names("C:\\Tools\\Git.EXE log")).toEqual(["git"]);
    expect(names("& 'C:\\Program Files\\Git\\git.exe' log")).toEqual(["git"]);
    expect(names("git commit -m 'a; b | c'")).toEqual(["git"]);
    expect(names("ssh user@host")).toEqual(["ssh"]);
  });

  it("leaves anything it cannot be sure of unclassified", () => {
    expect(names("& $tool")).toEqual([null]);
    expect(names("$x = git status")).toEqual([null]);
    expect(names("git log $(Remove-Item x)")).toEqual([null]);
    expect(names("git commit -m \"$(Remove-Item x)\"")).toEqual([null]);
    expect(names("foreach ($f in 1..2) { rm $f }")).toEqual([null]);
    expect(names("[IO.File]::WriteAllText('a','b')")).toEqual([null]);
    expect(names("iex @'\nrm x\n'@")).toEqual([null]);
    expect(names("git `\n status")).toEqual([null]);
    expect(names("git log 'unterminated")).toEqual([null]);
  });

  it("detects writes to files but not stream merges", () => {
    expect(powershellEvidence("git status 2>&1").write_redirection).toBe(false);
    expect(powershellEvidence("git status 2>&1").executables).toEqual(["git"]);
    expect(powershellEvidence("git status > out.txt").write_redirection).toBe(true);
    expect(powershellEvidence("git status > out.txt").executables).toEqual(["git"]);
    expect(powershellEvidence("echo a >> log.txt; npm test").executables).toEqual(["echo", "npm"]);
    expect(powershellEvidence("echo 'a > b'").write_redirection).toBe(false);
    expect(powershellEvidence("git log 'x > y").write_redirection).toBe(true);
  });

  it("collects literal URLs", () => {
    expect(powershellEvidence("curl https://a.example/x; Invoke-WebRequest 'http://b.example'").urls).toEqual([
      "https://a.example/x", "http://b.example",
    ]);
    expect(powershellEvidence("git status").urls).toEqual([]);
  });
});
