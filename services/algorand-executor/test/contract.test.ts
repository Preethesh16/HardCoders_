import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("compiled escrow contract source invariants", () => {
  it("requires buyer-signed funding and exposes the complete lifecycle", async () => {
    const source = await readFile(new URL("../contracts/optiwork-escrow.algo.ts", import.meta.url), "utf8");
    expect(source).toContain("funding.sender === record.originProvider.native");
    expect(source).not.toContain("funding.sender === Txn.sender");
    expect(source).toContain("assetReceiver: record.destinationProvider.native");
    for (const method of ["createEscrow", "fundEscrow", "releaseEscrow", "pauseEscrow", "resumeEscrow", "refundEscrow", "completeEscrow"]) {
      expect(source).toContain(`public ${method}(`);
    }
    expect(source).toContain("milestone already released");
    expect(source).toContain("lease expired");
    expect(source).toContain("bindingHash: arc4.StaticBytes<32>");
    expect(source).toContain("bindingHash,");
  });
});
