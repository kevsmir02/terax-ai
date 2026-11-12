import { afterEach, describe, expect, it } from "vitest";
import { runCodeBlockCommand, setCodeBlockRunner } from "./codeBlockRunner";

afterEach(() => setCodeBlockRunner(null));

describe("runCodeBlockCommand", () => {
  it("refuses when no terminal surface is published", () => {
    expect(runCodeBlockCommand("ls")).toBe(false);
  });

  it("passes the command to the published terminal action", () => {
    const seen: string[] = [];
    setCodeBlockRunner((command) => {
      seen.push(command);
      return true;
    });
    expect(runCodeBlockCommand("pnpm test")).toBe(true);
    expect(seen).toEqual(["pnpm test"]);
  });

  it("reports a refused write so the button does not claim success", () => {
    setCodeBlockRunner(() => false);
    expect(runCodeBlockCommand("ls")).toBe(false);
  });

  it("stops running once the terminal surface goes away", () => {
    setCodeBlockRunner(() => true);
    setCodeBlockRunner(null);
    expect(runCodeBlockCommand("ls")).toBe(false);
  });
});
