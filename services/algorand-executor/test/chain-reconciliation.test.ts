import { describe, expect, it } from "vitest";

import { classifyPreparedTransaction } from "../src/chain.js";

describe("prepared Algorand transaction classification", () => {
  it("keeps a transaction active before its last valid round", () => {
    expect(classifyPreparedTransaction("100", 99n, null)).toEqual({
      status: "PENDING",
      observedRound: "99",
    });
  });

  it("does not treat pending lookup absence alone as definitive at lastValidRound", () => {
    expect(classifyPreparedTransaction("100", 100n, null)).toEqual({
      status: "PENDING",
      observedRound: "100",
    });
  });

  it("expires only after the signed validity window was scanned", () => {
    expect(classifyPreparedTransaction("100", 100n, null, true)).toEqual({
      status: "EXPIRED",
      observedRound: "100",
    });
  });

  it("lets confirmation evidence win even at or after the validity boundary", () => {
    expect(classifyPreparedTransaction("100", 101n, 100n)).toEqual({
      status: "CONFIRMED",
      observedRound: "101",
      confirmedRound: "100",
    });
  });
});
