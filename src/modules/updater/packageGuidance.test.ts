import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import namespace from "@/modules/identity/namespace.json";
import { archGuidance, packageGuidanceFor } from "./packageGuidance";

const root = join(import.meta.dirname, "../../..");
const readText = (path: string) => readFileSync(join(root, path), "utf8");

/** A packaging input read from the producer, so this test cannot restate a name. */
function packagingConstant(name: string): string {
  const match = new RegExp(`^${name} = "([^"]+)"`, "m").exec(
    readText("scripts/packaging.py"),
  );
  if (!match) throw new Error(`scripts/packaging.py has no ${name}`);
  return match[1];
}

const packageName = namespace.packaging.packageName;
const debArch = packagingConstant("DEB_ARCH");
const rpmArch = packagingConstant("RPM_ARCH");

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

describe("deb/rpm handoff names an artifact this fork can actually have", () => {
  const version = "1.2.3";
  const commandFor = (distro: "debian" | "fedora"): string =>
    packageGuidanceFor(distro, version).steps[0].command ?? "";

  it("names the deb under the candidate package name, arch and version", () => {
    // Composed from the identity table and the packaging runner: upstream's
    // `./Terax_<version>_amd64.deb` is a file this fork never produces.
    expect(commandFor("debian")).toContain(
      `./${packageName}_${version}_${debArch}.deb`,
    );
  });

  it("leaves the rpm release number as a placeholder, not an invented one", () => {
    // The dialog cannot know the rpm release Tauri's bundler will choose, so a
    // literal number here would tell the reader to install a file that may not exist.
    expect(commandFor("fedora")).toContain(
      `./${packageName}-${version}-<release>.${rpmArch}.rpm`,
    );
  });

  it("uses placeholders when the caller does not pass a version", () => {
    expect(packageGuidanceFor("debian").steps[0].command).toContain(
      `./${packageName}_<version>_${debArch}.deb`,
    );
    expect(packageGuidanceFor("fedora").steps[0].command).toContain(
      `./${packageName}-<version>-<release>.${rpmArch}.rpm`,
    );
  });

  it("agrees with the artifact patterns the package document publishes", () => {
    const doc = readText("docs/architecture/linux-packages.md");
    expect(doc).toContain(`${packageName}_<version>_${debArch}.deb`);
    expect(doc).toContain(`${packageName}-<version>-<release>.${rpmArch}.rpm`);
    // No dialog step may send the reader to upstream's product name.
    for (const step of [
      ...packageGuidanceFor("debian", version).steps,
      ...packageGuidanceFor("fedora", version).steps,
    ]) {
      if (step.command) expect(step.command).not.toMatch(/\.\/Terax[_-]/);
    }
  });
});
