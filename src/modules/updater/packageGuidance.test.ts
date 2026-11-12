import { describe, expect, it } from "vitest";
import { archGuidance, packageGuidanceFor } from "./packageGuidance";

describe("Arch package-tool guidance", () => {
  it("routes Arch updates to package tooling, never an in-app installer", () => {
    const guidance = archGuidance();
    expect(guidance.distro).toBe("arch");
    expect(guidance.appInstalls).toBe(false);
    expect(guidance.tooling).toEqual(
      expect.arrayContaining(["pacman", "makepkg", "AUR helper"]),
    );
    expect(guidance.summary).toMatch(/does not install/i);
    expect(guidance.summary).toMatch(/Arch/i);
  });

  it("gives commands the user runs, not commands the application invokes", () => {
    const guidance = archGuidance();
    const commands = guidance.steps.flatMap((step) =>
      step.command ? [step.command] : [],
    );
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((command) => command.includes("pacman -Syu"))).toBe(
      true,
    );
    expect(commands.some((command) => command.includes("makepkg -si"))).toBe(
      true,
    );
    // No privileged helper is ever named as something Terax runs for the user.
    for (const command of commands) {
      expect(command).not.toMatch(/pkexec|polkit|systemctl|sudo/);
    }
    expect(guidance.steps.every((step) => step.by === "user")).toBe(true);
    // The inherited dialog invented an AUR package name; the fork owns no published AUR
    // recipe yet, so guidance must not assert one.
    expect(commands.join(" ")).not.toContain("terax-bin");
  });

  it("keeps the deb/rpm handoff honest about who runs the transaction", () => {
    for (const distro of ["debian", "fedora"] as const) {
      const guidance = packageGuidanceFor(distro);
      expect(guidance.appInstalls).toBe(false);
      expect(guidance.steps.every((step) => step.by === "user")).toBe(true);
      expect(guidance.summary).toMatch(/package tool/i);
    }
  });
});
