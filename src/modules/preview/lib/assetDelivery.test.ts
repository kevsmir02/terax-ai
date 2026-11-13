import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSET_DELIVERY,
  ASSET_DELIVERY_CHUNKS_PER_READ,
  assetDeliveryDecision,
  assetFailureNotice,
  assetUrlWithOverride,
} from "./assetDelivery";
import {
  MAX_CONCURRENT_DECODED_VIEWERS,
  MIB,
  TEXT_OVERRIDE_LIMIT_BYTES,
  TEXT_READ_LIMIT_BYTES,
} from "./limits";

const root = join(import.meta.dirname, "../../../..");
const rust = readFileSync(
  join(root, "src-tauri/src/modules/fs/assets.rs"),
  "utf8",
);

describe("asset delivery bounds", () => {
  it("reuses the approved read ceilings instead of declaring new ones", () => {
    expect(ASSET_DELIVERY.readBytes).toBe(TEXT_READ_LIMIT_BYTES);
    expect(ASSET_DELIVERY.overrideBytes).toBe(TEXT_OVERRIDE_LIMIT_BYTES);
    expect(ASSET_DELIVERY.chunkBytes).toBe(
      TEXT_READ_LIMIT_BYTES / ASSET_DELIVERY_CHUNKS_PER_READ,
    );
    expect(ASSET_DELIVERY.outstandingReads).toBe(
      MAX_CONCURRENT_DECODED_VIEWERS,
    );
    expect(ASSET_DELIVERY.outstandingBytes).toBe(TEXT_OVERRIDE_LIMIT_BYTES);
  });

  it("is mirrored by the native scheme handler, not re-declared there", () => {
    expect(rust).toMatch(
      new RegExp(
        `const MAX_OUTSTANDING_DELIVERIES: usize = ${MAX_CONCURRENT_DECODED_VIEWERS};`,
      ),
    );
    expect(rust).toContain("read_bytes: MAX_READ_BYTES");
    expect(rust).toContain("override_bytes: FORCE_MAX_READ_BYTES");
    expect(rust).toContain("outstanding_bytes: FORCE_MAX_READ_BYTES");
    expect(rust).toContain(
      `chunk_bytes: MAX_READ_BYTES / ${ASSET_DELIVERY_CHUNKS_PER_READ}`,
    );
    // A new MiB literal in the native delivery path would be a second,
    // unapproved ceiling.
    expect(rust).not.toMatch(/const [A-Z_]+: u64 = \d+ \* 1024 \* 1024/);
  });
});

describe("assetDeliveryDecision", () => {
  it("loads a small image as one bounded read", () => {
    expect(assetDeliveryDecision(TEXT_READ_LIMIT_BYTES, "image")).toEqual({
      kind: "load",
      bytes: TEXT_READ_LIMIT_BYTES,
      streamed: false,
    });
  });

  it("asks for an explicit choice one byte above the read ceiling", () => {
    const decision = assetDeliveryDecision(TEXT_READ_LIMIT_BYTES + 1, "image");
    expect(decision.kind).toBe("confirm");
    if (decision.kind !== "confirm") return;
    expect(decision.overrideLimitBytes).toBe(TEXT_OVERRIDE_LIMIT_BYTES);
    expect(decision.alternatives).toContain("open-externally");
    expect(decision.reason).toContain("10 MiB");
    expect(decision.reason).toContain("50 MiB");
  });

  it("loads the explicit choice up to the override ceiling", () => {
    expect(
      assetDeliveryDecision(TEXT_OVERRIDE_LIMIT_BYTES, "pdf", {
        override: true,
      }),
    ).toEqual({
      kind: "load",
      bytes: TEXT_OVERRIDE_LIMIT_BYTES,
      streamed: false,
    });
  });

  it("refuses above the override ceiling with an external viewer", () => {
    const decision = assetDeliveryDecision(
      TEXT_OVERRIDE_LIMIT_BYTES + 1,
      "pdf",
      { override: true },
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.alternatives).toEqual(["open-externally"]);
    expect(decision.reason).toContain("50 MiB");
  });

  it("streams audio and video however large they are", () => {
    for (const kind of ["audio", "video"] as const) {
      expect(assetDeliveryDecision(8 * 1024 * MIB, kind)).toEqual({
        kind: "load",
        bytes: 8 * 1024 * MIB,
        streamed: true,
      });
    }
  });

  it("refuses an asset whose size could not be measured", () => {
    for (const bytes of [null, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const decision = assetDeliveryDecision(bytes, "image");
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse") {
        expect(decision.alternatives).toContain("open-externally");
      }
    }
  });
});

describe("assetUrlWithOverride", () => {
  it("appends the explicit choice to an existing grant query", () => {
    expect(assetUrlWithOverride("asset://localhost/a.png?token=t", true)).toBe(
      "asset://localhost/a.png?token=t&override=1",
    );
    expect(assetUrlWithOverride("asset://localhost/a.png", true)).toBe(
      "asset://localhost/a.png?override=1",
    );
    expect(assetUrlWithOverride("asset://localhost/a.png?token=t", false)).toBe(
      "asset://localhost/a.png?token=t",
    );
  });
});

describe("assetFailureNotice", () => {
  it("has nothing to say about a successful grant", () => {
    expect(assetFailureNotice(undefined)).toBeNull();
    expect(assetFailureNotice("")).toBeNull();
  });

  it("names a boundary refusal and does not offer a pointless retry", () => {
    const notice = assetFailureNotice("opened asset escaped its grant");
    expect(notice?.retryable).toBe(false);
    expect(notice?.reason).toContain("outside the folder");
    expect(notice?.alternatives).toContain("open-externally");
  });

  it("offers a retry when the grant surface is exhausted", () => {
    const notice = assetFailureNotice("too many active media grants");
    expect(notice?.retryable).toBe(true);
    expect(notice?.reason).toContain("too many media views");
  });

  it("keeps an unknown native error readable", () => {
    const notice = assetFailureNotice("No such file or directory (os error 2)");
    expect(notice?.retryable).toBe(true);
    expect(notice?.reason).toContain("os error 2");
    expect(notice?.alternatives).toContain("open-externally");
  });
});
