import { useMemo } from "react";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import type { UnfinishedRefundStatus } from "@calcom/lib/payment/getUnfinishedRefundStatus";
import { RefundPolicy } from "@calcom/lib/payment/types";
import { BookingStatus } from "@calcom/prisma/enums";

interface Payment {
  success: boolean;
  refunded: boolean;
  /**
   * State of a refund that has not been completed: still processing in Stripe, waiting for an action,
   * or failed (the money has not been returned).
   */
  refundStatus?: UnfinishedRefundStatus | null;
  paymentOption?: string | null;
}

interface UsePaymentStatusParams {
  bookingStatus: BookingStatus;
  startTime: Date | string;
  eventTypeTeamId?: number | null;
  userId?: number | null;
  payment: Payment;
  refundPolicy?: string | null;
  refundDaysCount?: number | null;
}

/**
 * Hook to determine the appropriate payment status message for a booking
 * based on payment status and refund policy.
 */
export function usePaymentStatus({
  bookingStatus,
  startTime,
  eventTypeTeamId,
  userId,
  payment,
  refundPolicy,
  refundDaysCount,
}: UsePaymentStatusParams) {
  const { t } = useLocale();

  const message = useMemo(() => {
    const isCancelled = bookingStatus === BookingStatus.CANCELLED || bookingStatus === BookingStatus.REJECTED;

    if (!isCancelled) {
      return null;
    }

    // Payment not completed and not refunded
    if (!payment.success && !payment.refunded) {
      return t("booking_with_payment_cancelled");
    }

    // Payment completed and a refund was attempted but is not complete: say what actually happened
    if (payment.success && !payment.refunded) {
      if (payment.refundStatus === "pending") return t("booking_with_payment_cancelled_refund_pending");
      if (payment.refundStatus === "requires_action") {
        return t("booking_with_payment_cancelled_refund_requires_action");
      }
      if (payment.refundStatus === "failed") return t("booking_with_payment_cancelled_refund_failed");
    }

    // Payment completed but not refunded
    if (payment.success && !payment.refunded) {
      // Handle missing team or event type owner (same in processPaymentRefund.ts)
      if (!eventTypeTeamId && !userId) {
        return t("booking_with_payment_cancelled_no_refund");
      }

      // Handle DAYS policy with expired refund window
      if (refundPolicy === RefundPolicy.DAYS && refundDaysCount) {
        const bookingStartTime = new Date(startTime);
        const cancelTime = new Date();
        const daysDiff = Math.floor(
          (cancelTime.getTime() - bookingStartTime.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysDiff > refundDaysCount) {
          return t("booking_with_payment_cancelled_refund_window_expired");
        }
        return t("booking_with_payment_cancelled_already_paid");
      }

      // Handle NEVER policy
      if (refundPolicy === RefundPolicy.NEVER) {
        return t("booking_with_payment_cancelled_no_refund");
      }

      // Handle ALWAYS policy or default
      return t("booking_with_payment_cancelled_already_paid");
    }

    // Payment refunded
    if (payment.refunded) {
      return t("booking_with_payment_cancelled_refunded");
    }

    return null;
  }, [bookingStatus, startTime, eventTypeTeamId, userId, payment, refundPolicy, refundDaysCount, t]);

  return message;
}
