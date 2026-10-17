import { RefundPolicy } from "@calcom/lib/payment/types";
import { BookingStatus } from "@calcom/prisma/enums";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePaymentStatus } from "./usePaymentStatus";

vi.mock("@calcom/lib/hooks/useLocale", () => ({ useLocale: () => ({ t: (key: string) => key }) }));

function messageFor(payment: Parameters<typeof usePaymentStatus>[0]["payment"]) {
  const { result } = renderHook(() =>
    usePaymentStatus({
      bookingStatus: BookingStatus.CANCELLED,
      startTime: new Date("2030-01-01T10:00:00Z"),
      userId: 1,
      payment,
      refundPolicy: RefundPolicy.ALWAYS,
    })
  );
  return result.current;
}

describe("usePaymentStatus refund messages", () => {
  it.each([
    ["refunded", { success: true, refunded: true }, "booking_with_payment_cancelled_refunded"],
    [
      "refund processing",
      { success: true, refunded: false, refundStatus: "pending" as const },
      "booking_with_payment_cancelled_refund_pending",
    ],
    [
      "refund waiting for an action",
      { success: true, refunded: false, refundStatus: "requires_action" as const },
      "booking_with_payment_cancelled_refund_requires_action",
    ],
    [
      "refund failed",
      { success: true, refunded: false, refundStatus: "failed" as const },
      "booking_with_payment_cancelled_refund_failed",
    ],
    [
      "refund not attempted yet",
      { success: true, refunded: false, refundStatus: null },
      "booking_with_payment_cancelled_already_paid",
    ],
    ["never paid", { success: false, refunded: false }, "booking_with_payment_cancelled"],
  ])("%s → %s", (_label, payment, expected) => {
    expect(messageFor(payment)).toBe(expected);
  });
});
