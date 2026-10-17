import { isPrismaObjOrUndefined } from "@calcom/lib/isPrismaObj";
import type { Prisma } from "@calcom/prisma/client";

export type UnfinishedRefundStatus = "pending" | "requires_action" | "failed";

/**
 * Reads, from Payment.data, the state of a refund that has not been completed, as recorded by the payment
 * service (`refund.status` for a refund Stripe is still processing, `refundFailure` for a failed attempt).
 * A requested refund that has not finished wins over an earlier failure: the money was already asked for.
 */
export function getUnfinishedRefundStatus(
  refunded: boolean,
  paymentData: Prisma.JsonValue
): UnfinishedRefundStatus | null {
  if (refunded) return null;
  const data = isPrismaObjOrUndefined(paymentData);
  const refundStatus = isPrismaObjOrUndefined(data?.refund)?.status;
  if (refundStatus === "pending" || refundStatus === "requires_action") return refundStatus;
  return data?.refundFailure !== undefined ? "failed" : null;
}
