import type { Prisma } from "@calcom/prisma/client";
import Stripe from "stripe";

/**
 * Refunds a Stripe payment of a booking.
 *
 * Payment.externalId holds what the payment was created with: a Checkout Session ID (`cs_…`) for
 * hosted checkout, a PaymentIntent ID (`pi_…`) for payments created before hosted checkout, or a
 * SetupIntent ID (`seti_…`) for HOLD payments, whose charge is stored in Payment.data.paymentIntent.
 * Refunds are always created against the PaymentIntent, on the same account the payment was made on.
 *
 * The refund is driven by the state in Stripe, not by Payment.refunded: what has already been refunded
 * is read back first, so repeating the call after a crash, a timeout or a concurrent request does not
 * refund twice. Calling it again later is also how a refund that was still processing is re-checked.
 *
 * Refund states:
 * - succeeded: money is back. Only this counts as refunded.
 * - pending, requires_action (and any state Stripe adds later): not finished yet. The amount counts as
 *   already requested, so it is never requested a second time, but the payment is not refunded yet.
 * - failed, canceled: nothing was returned; the amount can be requested again.
 */

export type RefundablePayment = {
  uid: string;
  externalId: string;
  data: Prisma.JsonValue;
};

export type RefundOutcome =
  | {
      /**
       * succeeded: the whole amount is back.
       * pending: the whole amount is requested, part of it is still being processed by Stripe.
       * requires_action: as pending, but a refund waits for an action (e.g. the customer's bank details).
       */
      status: "succeeded" | "pending" | "requires_action";
      paymentIntentId: string;
      amountReceived: number;
      /** Returned by refunds in state succeeded */
      amountSucceeded: number;
      /** Requested by refunds that have not finished yet */
      amountInProgress: number;
      /** Refunds counted above (failed and canceled ones are left out) */
      refundIds: string[];
      /** The refund created by this call, or null if Stripe already had refunds covering the payment */
      createdRefundId: string | null;
    }
  | {
      /** Nothing was charged (e.g. a 100% discount), so there is nothing to send back */
      status: "nothing_charged";
      paymentIntentId: string | null;
    };

export class StripeRefundError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "StripeRefundError";
  }
}

// Refunds in these states returned nothing; every other non-succeeded state is still in progress.
const UNSUCCESSFUL_REFUND_STATUSES = new Set(["failed", "canceled"]);

type RefundSummary = {
  amountSucceeded: number;
  amountInProgress: number;
  requiresAction: boolean;
  counted: Stripe.Refund[];
  unsuccessfulCount: number;
};

function summarizeRefunds(refunds: Stripe.Refund[]): RefundSummary {
  const summary: RefundSummary = {
    amountSucceeded: 0,
    amountInProgress: 0,
    requiresAction: false,
    counted: [],
    unsuccessfulCount: 0,
  };
  for (const refund of refunds) {
    if (refund.status && UNSUCCESSFUL_REFUND_STATUSES.has(refund.status)) {
      summary.unsuccessfulCount += 1;
      continue;
    }
    summary.counted.push(refund);
    if (refund.status === "succeeded") {
      summary.amountSucceeded += refund.amount;
    } else {
      summary.amountInProgress += refund.amount;
      if (refund.status === "requires_action") summary.requiresAction = true;
    }
  }
  return summary;
}

function getHeldPaymentIntentId(data: Prisma.JsonValue): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const paymentIntent = (data as Prisma.JsonObject).paymentIntent;
  if (!paymentIntent || typeof paymentIntent !== "object" || Array.isArray(paymentIntent)) return null;
  const id = (paymentIntent as Prisma.JsonObject).id;
  return typeof id === "string" && id.startsWith("pi_") ? id : null;
}

/** Returns the PaymentIntent that carries the money, or null if the payment charged nothing. */
export async function resolvePaymentIntentId(
  stripe: Stripe,
  payment: RefundablePayment
): Promise<string | null> {
  const { externalId } = payment;
  if (externalId.startsWith("pi_")) return externalId;

  if (externalId.startsWith("cs_")) {
    const session = await stripe.checkout.sessions.retrieve(externalId);
    if (session.payment_intent) {
      return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
    }
    if (session.payment_status === "no_payment_required") return null;
    throw new StripeRefundError(
      `Checkout Session ${externalId} has no PaymentIntent (payment_status: ${session.payment_status})`,
      false
    );
  }

  const heldPaymentIntentId = getHeldPaymentIntentId(payment.data);
  if (heldPaymentIntentId) return heldPaymentIntentId;

  throw new StripeRefundError(`Payment ${payment.uid} has no Stripe charge to refund`, false);
}

async function listRefunds(stripe: Stripe, paymentIntentId: string): Promise<Stripe.Refund[]> {
  const refunds: Stripe.Refund[] = [];
  for await (const refund of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
    refunds.push(refund);
  }
  return refunds;
}

/**
 * Requests whatever part of the PaymentIntent has not been requested yet (the whole payment, or the rest
 * of a partially refunded one). If Stripe already has refunds covering the payment, nothing is created.
 */
export async function refundPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string,
  paymentUid: string
): Promise<RefundOutcome> {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const amountReceived = paymentIntent.amount_received ?? 0;
  if (paymentIntent.status !== "succeeded") {
    throw new StripeRefundError(
      `PaymentIntent ${paymentIntentId} is ${paymentIntent.status}; there is no captured payment to refund`,
      false
    );
  }
  if (amountReceived === 0) return { status: "nothing_charged", paymentIntentId };

  const refunds = await listRefunds(stripe, paymentIntentId);
  const before = summarizeRefunds(refunds);
  const alreadyRequested = before.amountSucceeded + before.amountInProgress;

  let createdRefundId: string | null = null;
  if (alreadyRequested < amountReceived) {
    // A retry of the same attempt (same refunds in Stripe) reuses the key and gets the same refund back.
    // After a refund failed or was canceled, or after a partial refund, the next attempt gets a new key.
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: amountReceived - alreadyRequested,
        metadata: { calPaymentUid: paymentUid },
      },
      {
        idempotencyKey: `cal-payment-${paymentUid}-refund-${alreadyRequested}-of-${amountReceived}-after-${before.unsuccessfulCount}-unsuccessful`,
      }
    );
    createdRefundId = refund.id;
    // The listed copy is newer than a replayed creation response, so it wins.
    if (!refunds.some((existing) => existing.id === refund.id)) refunds.push(refund);
    if (refund.status && UNSUCCESSFUL_REFUND_STATUSES.has(refund.status)) {
      throw new StripeRefundError(
        `Refund ${refund.id} for PaymentIntent ${paymentIntentId} is ${refund.status}${
          refund.failure_reason ? ` (${refund.failure_reason})` : ""
        }`,
        false
      );
    }
  }

  const after = summarizeRefunds(refunds);
  if (after.amountSucceeded + after.amountInProgress < amountReceived) {
    throw new StripeRefundError(
      `PaymentIntent ${paymentIntentId}: ${after.amountSucceeded + after.amountInProgress} of ${amountReceived} requested after the refund request`,
      true
    );
  }

  let status: "succeeded" | "pending" | "requires_action" = "pending";
  if (after.amountSucceeded >= amountReceived) status = "succeeded";
  else if (after.requiresAction) status = "requires_action";

  return {
    status,
    paymentIntentId,
    amountReceived,
    amountSucceeded: after.amountSucceeded,
    amountInProgress: after.amountInProgress,
    refundIds: after.counted.map((refund) => refund.id),
    createdRefundId,
  };
}

/**
 * Network problems, Stripe outages, rate limits and concurrent use of the same idempotency key.
 * Checked with instanceof: stripe-node sets `error.type` from the class name, which minification changes.
 */
export function isRetryableStripeError(error: unknown): boolean {
  if (error instanceof StripeRefundError) return error.retryable;
  const { StripeError, StripeConnectionError, StripeAPIError, StripeRateLimitError } = Stripe.errors;
  if (
    error instanceof StripeConnectionError ||
    error instanceof StripeAPIError ||
    error instanceof StripeRateLimitError
  ) {
    return true;
  }
  if (!(error instanceof StripeError)) return false;
  const { statusCode } = error;
  return statusCode === 409 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500);
}
