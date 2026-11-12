/**
 * Where an Arch user goes for an update.
 *
 * Arch is package-tool managed. This application never adds a privileged Arch installer:
 * it does not run pacman/makepkg/AUR helpers and does not ask for privilege to replace
 * itself. The dialog shows these instructions to the user; it never executes them.
 */
export interface PackageGuidance {
  distro: "arch" | "debian" | "fedora";
  title: string;
  summary: string;
  tooling: string[];
  steps: {
    label: string;
    command?: string;
    /** Every step is run by the user, never by Terax. */
    by: "user";
  }[];
  /** Always false: this build hands off to package tooling instead of installing. */
  appInstalls: false;
}

export function archGuidance(): PackageGuidance {
  return {
    distro: "arch",
    title: "Arch Linux — update with package tooling",
    summary:
      "Terax does not install or upgrade itself on Arch. Arch updates stay with pacman " +
      "and your AUR helper or makepkg recipe, so package ownership and dependencies " +
      "remain with the package tool.",
    tooling: ["pacman", "makepkg", "AUR helper"],
    steps: [
      {
        label: "Upgrade the system package database and installed packages.",
        command: "pacman -Syu",
        by: "user",
      },
      {
        label:
          "Or build and install the fork's Arch recipe from its source directory once it is available.",
        command: "makepkg -si",
        by: "user",
      },
      {
        label:
          "Close Terax before the package tool replaces it; Terax never relaunches itself.",
        by: "user",
      },
    ],
    appInstalls: false,
  };
}

export function packageGuidanceFor(
  distro: PackageGuidance["distro"],
  version = "",
): PackageGuidance {
  if (distro === "arch") return archGuidance();

  const shownVersion = version || "<version>";
  const debian = distro === "debian";
  const artifact = debian
    ? `./Terax_${shownVersion}_amd64.deb`
    : `./Terax-${shownVersion}-1.x86_64.rpm`;
  const tool = debian ? "apt" : "dnf";
  return {
    distro,
    title: `${debian ? "Debian / Ubuntu" : "Fedora / RHEL"} — package-tool handoff`,
    summary:
      "Download the package with your browser or package tool and install it with that " +
      "package tool so dependencies and ownership stay with it. Terax does not run the " +
      "transaction.",
    tooling: [tool],
    steps: [
      {
        label: `Install the downloaded ${debian ? "deb" : "rpm"} package with your package tool.`,
        command: `${tool} ${debian ? "install" : "upgrade"} ${artifact}`,
        by: "user",
      },
      {
        label:
          "Close Terax before replacing it; Terax never relaunches itself.",
        by: "user",
      },
    ],
    appInstalls: false,
  };
}
