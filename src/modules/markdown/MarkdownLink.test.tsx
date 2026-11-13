import { openExternalUrl } from "@/lib/external-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownLinkAction } from "./lib/linkAction";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describe("MarkdownLink", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "https://chatgpt.com/codex/settings/usage",
    "mailto:support@example.com",
    "tel:+16045550123",
  ])("opens supported links natively: %s", async (href) => {
    openUrl.mockResolvedValue(undefined);
    const onSettled = vi.fn();

    await openExternalUrl(href, onSettled);

    expect(openUrl).toHaveBeenCalledWith(href);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("still settles when opening fails", async () => {
    openUrl.mockRejectedValue(new Error("browser unavailable"));
    const onSettled = vi.fn();

    await openExternalUrl("https://example.com", onSettled);

    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("keeps every non-external link inert instead of navigating the app", () => {
    for (const href of [
      "./other.md",
      "../notes.md",
      "/etc/passwd",
      "file:///home/me/notes.md",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "terax://open?path=/etc/passwd",
      "",
      null,
    ]) {
      expect(markdownLinkAction(href)).toEqual({ kind: "inert" });
    }
  });

  it("routes only supported external targets to the opener", () => {
    expect(markdownLinkAction("HTTPS://example.com/a")).toEqual({
      kind: "external",
      href: "HTTPS://example.com/a",
    });
    expect(markdownLinkAction("mailto:me@example.com").kind).toBe("external");
    expect(markdownLinkAction("tel:+16045550123").kind).toBe("external");
  });

  it("does not invoke the native opener for unsupported schemes", async () => {
    const onSettled = vi.fn();

    await openExternalUrl("javascript:alert(1)", onSettled);

    expect(openUrl).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
  });
});
