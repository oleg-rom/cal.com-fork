import { describe, expect, it } from "vitest";

import { getUnfinishedRefundStatus } from "./getUnfinishedRefundStatus";

describe("getUnfinishedRefundStatus", () => {
  it.each([
    ["refunded payment", true, { refund: { status: "succeeded" } }, null],
    ["refunded payment with an old failure", true, { refundFailure: { reason: "x" } }, null],
    ["no refund attempted", false, { checkoutSessionId: "cs_1" }, null],
    ["refund still processing", false, { refund: { status: "pending" } }, "pending"],
    ["refund waiting for an action", false, { refund: { status: "requires_action" } }, "requires_action"],
    ["failed attempt", false, { refundFailure: { reason: "x", retryable: true } }, "failed"],
    [
      "processing refund and a later failed re-check",
      false,
      { refund: { status: "pending" }, refundFailure: {} },
      "pending",
    ],
    ["empty data", false, null, null],
    ["non-object data", false, "text", null],
  ])("%s → %s", (_label, refunded, data, expected) => {
    expect(getUnfinishedRefundStatus(refunded, data)).toBe(expected);
  });
});
