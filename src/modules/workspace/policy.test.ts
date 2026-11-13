import { describe, expect, it } from "vitest";
import {
  checkReadable,
  checkReadableCanonical,
  checkWritable,
  checkWritableCanonical,
} from "./policy";

describe("checkReadable — secret basenames", () => {
  it("blocks plain .env", () => {
    expect(checkReadable("/home/me/.env")).toMatchObject({ ok: false });
  });

  it("blocks .env.local and .env.production", () => {
    expect(checkReadable("/home/me/.env.local")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/.env.production")).toMatchObject({
      ok: false,
    });
  });

  it("blocks .env with trailing Windows-stripped characters", () => {
    expect(checkReadable("C:\\Users\\me\\.env.")).toMatchObject({ ok: false });
    expect(checkReadable("C:\\Users\\me\\.env ")).toMatchObject({ ok: false });
  });

  it("blocks NTFS alternate-data-stream notation for .env", () => {
    expect(checkReadable("C:\\Users\\me\\.env::$DATA")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("C:\\Users\\me\\.env:stream")).toMatchObject({
      ok: false,
    });
  });

  it("blocks SSH key backup naming patterns", () => {
    expect(checkReadable("/home/me/Documents/id_rsa")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("/home/me/Documents/id_rsa.bak")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("/home/me/Documents/id_rsa_old")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("/home/me/Documents/id_ed25519-backup")).toMatchObject(
      {
        ok: false,
      },
    );
    expect(checkReadable("/home/me/Documents/id_rsa.pub")).toMatchObject({
      ok: false,
    });
  });

  it("does not block names that merely start with id_rsa- prefix-prefix", () => {
    expect(checkReadable("/home/me/Documents/id_rsaxyz.txt")).toMatchObject({
      ok: true,
    });
  });

  it("blocks credentials, .npmrc, .pypirc basenames", () => {
    expect(checkReadable("/home/me/.aws/credentials")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("/home/me/.npmrc")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/.pypirc")).toMatchObject({ ok: false });
  });

  it("blocks *.pem, *.key, *.pfx regardless of basename prefix", () => {
    expect(checkReadable("/home/me/server.pem")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/server.key")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/cert.pfx")).toMatchObject({ ok: false });
  });
});

describe("checkReadable — protected directories", () => {
  it("blocks reads under ~/.ssh, .aws, .kube, .git", () => {
    expect(checkReadable("/home/me/.ssh/config")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/.aws/config")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/.kube/config")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/repo/.git/config")).toMatchObject({
      ok: false,
    });
  });

  it("blocks reads under /etc, /proc, /sys (newly added)", () => {
    expect(checkReadable("/etc/shadow")).toMatchObject({ ok: false });
    expect(checkReadable("/etc/nginx/nginx.conf")).toMatchObject({ ok: false });
    expect(checkReadable("/proc/self/environ")).toMatchObject({ ok: false });
    expect(checkReadable("/sys/class/dmi/id/product_uuid")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("/private/etc/master.passwd")).toMatchObject({
      ok: false,
    });
  });

  it("rejects path-segment look-alikes (.sshx is not .ssh)", () => {
    expect(checkReadable("/home/me/.sshx/file")).toMatchObject({ ok: true });
    expect(checkReadable("/home/me/.gitignore-stuff/config")).toMatchObject({
      ok: true,
    });
  });

  it("rejects writes under Windows system dirs (case-insensitive)", () => {
    expect(checkWritable("C:\\Windows\\System32\\file")).toMatchObject({
      ok: false,
    });
    expect(checkWritable("c:/PROGRAM FILES/x")).toMatchObject({ ok: false });
  });

  it("allows reads in user directories not under any protected dir", () => {
    expect(checkReadable("/home/me/Documents/notes.txt")).toMatchObject({
      ok: true,
    });
    expect(checkReadable("C:/Users/me/Documents/report.docx")).toMatchObject({
      ok: true,
    });
  });
});

describe("checkReadable — path normalization", () => {
  it("normalizes UNC and extended-length prefixes", () => {
    expect(checkReadable("\\\\?\\C:\\Users\\me\\.ssh\\id_rsa")).toMatchObject({
      ok: false,
    });
  });

  it("treats case-insensitively for protected dirs", () => {
    expect(checkReadable("/Home/Me/.SSH/config")).toMatchObject({ ok: false });
  });

  it("rejects empty paths and control bytes", () => {
    expect(checkReadable("")).toMatchObject({ ok: false });
    expect(checkReadable("/home/me/\x00.txt")).toMatchObject({ ok: false });
  });
});

describe("checkReadableCanonical — symlink defense + always-recheck", () => {
  it("rechecks even when canonical equals input", async () => {
    const identity = async (p: string) => p;
    const r = await checkReadableCanonical("/etc/nginx/nginx.conf", identity);
    expect(r.ok).toBe(false);
  });

  it("catches a symlink that resolves into ~/.ssh", async () => {
    const symlinkResolves = async (p: string) =>
      p === "/home/me/innocent" ? "/home/me/.ssh/id_rsa" : p;
    const r = await checkReadableCanonical(
      "/home/me/innocent",
      symlinkResolves,
    );
    expect(r.ok).toBe(false);
  });

  it("passes a normal allowed read through with canonical path", async () => {
    const identity = async (p: string) => p;
    const r = await checkReadableCanonical(
      "/home/me/Documents/notes.txt",
      identity,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical).toBe("/home/me/Documents/notes.txt");
  });
});

describe("checkReadable — normalization edge matrix", () => {
  it("catches protected dirs addressed with raw Windows separators", () => {
    expect(checkReadable("C:\\Users\\me\\.ssh\\config")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("C:\\Users\\me\\.aws\\credentials")).toMatchObject({
      ok: false,
    });
  });

  it("catches drive-letter forms without any prefix trick", () => {
    expect(checkReadable("C:/Users/me/.ssh/id_rsa")).toMatchObject({
      ok: false,
    });
  });

  it("applies NTFS stream notation to every secret pattern, not just .env", () => {
    expect(checkReadable("/home/me/server.pem::$DATA")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("/home/me/id_rsa:stream")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("/home/me/.netrc:safe")).toMatchObject({ ok: false });
  });

  it("strips trailing dots and spaces from directory segments too", () => {
    expect(checkReadable("/home/me/.ssh./config")).toMatchObject({
      ok: false,
    });
    expect(checkReadable("C:\\Users\\me\\.ssh .\\id_rsa")).toMatchObject({
      ok: false,
    });
  });

  it("collapses duplicate slashes before matching", () => {
    expect(checkReadable("//home//me/.ssh/config")).toMatchObject({
      ok: false,
    });
  });

  it("treats a trailing slash as the same directory", () => {
    expect(checkReadable("/home/me/.ssh/")).toMatchObject({ ok: false });
  });

  it("keeps look-alike suffixes after normalization allowed", () => {
    expect(checkReadable("/home/me/.sshx./file")).toMatchObject({ ok: true });
  });
});

describe("checkWritable — layered refusals", () => {
  it("inherits every read refusal", () => {
    expect(checkWritable("/home/me/.ssh/authorized_keys")).toMatchObject({
      ok: false,
    });
    expect(checkWritable("/home/me/server.pem")).toMatchObject({ ok: false });
  });

  it("refuses writes under protected system dirs on both platforms", () => {
    expect(checkWritable("/etc/hosts")).toMatchObject({ ok: false });
    expect(checkWritable("/private/etc/hosts")).toMatchObject({ ok: false });
    expect(checkWritable("C:\\ProgramData\\x.txt")).toMatchObject({
      ok: false,
    });
  });

  it("allows writes in ordinary user space", () => {
    expect(checkWritable("/home/me/project/main.rs")).toMatchObject({
      ok: true,
    });
  });
});

describe("checkReadableCanonical — parent-directory fallback", () => {
  it("canonicalizes the parent when the target does not exist yet", async () => {
    const canonicalize = async (p: string) => {
      if (p === "/home/me/link/newfile.txt") throw new Error("enoent");
      return p === "/home/me/link" ? "/home/me/.ssh" : p;
    };
    const r = await checkWritableCanonical(
      "/home/me/link/newfile.txt",
      canonicalize,
    );
    expect(r.ok).toBe(false);
  });

  it("passes through when neither target nor parent resolves", async () => {
    const failing = async () => {
      throw new Error("enoent");
    };
    const r = await checkWritableCanonical(
      "/home/me/project/newfile.txt",
      failing,
    );
    expect(r.ok).toBe(true);
  });
});

describe("application credentials", () => {
  it.each([
    "/Users/me/Library/Caches/terax/control.json",
    "/home/me/.cache/terax/control.json",
    "C:/Users/me/AppData/Local/terax/control.json",
  ])("refuses %s even inside a home grant", (path) => {
    expect(checkReadable(path).ok).toBe(false);
  });
});
