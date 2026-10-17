import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isRetryableStripeError,
  refundPaymentIntent,
  resolvePaymentIntentId,
  StripeRefundError,
} from "./refundPayment";

type FakeRefund = { id: string; amount: number; status: string | null; failure_reason?: string };

const keyFor = (requested: number, unsuccessful: number) =>
  `cal-payment-pay-uid-refund-${requested}-of-10000-after-${unsuccessful}-unsuccessful`;

/**
 * A minimal in-memory Stripe: one PaymentIntent, its refunds, and idempotent refund creation (a repeated
 * key replays the stored response, as Stripe does for 24 hours).
 */
function createFakeStripe(opts: {
  session?: Partial<Stripe.Checkout.Session>;
  paymentIntent?: { status: string; amount_received: number };
  refunds?: FakeRefund[];
  /** Status of each newly created refund, in order; the last one repeats */
  createStatuses?: (string | null)[];
}) {
  const refunds: FakeRefund[] = [...(opts.refunds ?? [])];
  const byIdempotencyKey = new Map<string, FakeRefund>();
  const statuses = opts.createStatuses ?? ["succeeded"];
  let created = 0;
  const stripe = {
    checkout: { sessions: { retrieve: vi.fn(async () => opts.session) } },
    paymentIntents: {
      retrieve: vi.fn(async () => opts.paymentIntent ?? { status: "succeeded", amount_received: 10000 }),
    },
    refunds: {
      list: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          for (const refund of [...refunds]) yield { ...refund };
        },
      })),
      create: vi.fn(async (params: { amount: number }, options: { idempotencyKey: string }) => {
        const replay = byIdempotencyKey.get(options.idempotencyKey);
        if (replay) return { ...replay };
        const status = statuses[Math.min(created, statuses.length - 1)];
        created += 1;
        const refund: FakeRefund = { id: `re_new_${created}`, amount: params.amount, status };
        if (status === "failed") refund.failure_reason = "expired_or_canceled_card";
        refunds.push(refund);
        byIdempotencyKey.set(options.idempotencyKey, { ...refund });
        return { ...refund };
      }),
    },
  };
  return { stripe: stripe as unknown as Stripe, mock: stripe, refunds };
}

describe("resolvePaymentIntentId", () => {
  it("uses the PaymentIntent ID stored by payments created before hosted checkout", async () => {
    const { stripe, mock } = createFakeStripe({});
    await expect(
      resolvePaymentIntentId(stripe, { uid: "u", externalId: "pi_legacy", data: {} })
    ).resolves.toBe("pi_legacy");
    expect(mock.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it("reads the PaymentIntent from the Checkout Session stored in externalId", async () => {
    const { stripe, mock } = createFakeStripe({
      session: { payment_intent: "pi_from_session", payment_status: "paid" },
    });
    await expect(
      resolvePaymentIntentId(stripe, { uid: "u", externalId: "cs_test_1", data: {} })
    ).resolves.toBe("pi_from_session");
    expect(mock.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_test_1");
  });

  it("accepts an expanded PaymentIntent object on the session", async () => {
    const { stripe } = createFakeStripe({
      session: { payment_intent: { id: "pi_expanded" } as Stripe.PaymentIntent, payment_status: "paid" },
    });
    await expect(
      resolvePaymentIntentId(stripe, { uid: "u", externalId: "cs_test_1", data: {} })
    ).resolves.toBe("pi_expanded");
  });

  it("returns null for a session that required no payment", async () => {
    const { stripe } = createFakeStripe({
      session: { payment_intent: null, payment_status: "no_payment_required" },
    });
    await expect(
      resolvePaymentIntentId(stripe, { uid: "u", externalId: "cs_test_free", data: {} })
    ).resolves.toBeNull();
  });

  it("fails clearly for a session without a PaymentIntent that is not free", async () => {
    const { stripe } = createFakeStripe({ session: { payment_intent: null, payment_status: "unpaid" } });
    await expect(
      resolvePaymentIntentId(stripe, { uid: "u", externalId: "cs_test_open", data: {} })
    ).rejects.toThrow(/has no PaymentIntent \(payment_status: unpaid\)/);
  });

  it("uses the charged PaymentIntent of a HOLD payment", async () => {
    const { stripe } = createFakeStripe({});
    await expect(
      resolvePaymentIntentId(stripe, {
        uid: "u",
        externalId: "seti_1",
        data: { setupIntent: { id: "seti_1" }, paymentIntent: { id: "pi_charged" } },
      })
    ).resolves.toBe("pi_charged");
  });

  it("fails clearly for a HOLD payment that was never charged", async () => {
    const { stripe } = createFakeStripe({});
    await expect(
      resolvePaymentIntentId(stripe, {
        uid: "u",
        externalId: "seti_1",
        data: { setupIntent: { id: "seti_1" } },
      })
    ).rejects.toThrow(/no Stripe charge to refund/);
  });
});

describe("refundPaymentIntent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refunds the whole payment against the PaymentIntent, with an explicit amount", async () => {
    const { stripe, mock } = createFakeStripe({});
    const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
    expect(mock.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 10000, metadata: { calPaymentUid: "pay-uid" } },
      { idempotencyKey: keyFor(0, 0) }
    );
    expect(outcome).toEqual({
      status: "succeeded",
      paymentIntentId: "pi_1",
      amountReceived: 10000,
      amountSucceeded: 10000,
      amountInProgress: 0,
      refundIds: ["re_new_1"],
      createdRefundId: "re_new_1",
    });
  });

  it("does not refund again when Stripe already has a full refund (e.g. the result was not saved)", async () => {
    const { stripe, mock } = createFakeStripe({
      refunds: [{ id: "re_old", amount: 10000, status: "succeeded" }],
    });
    const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
    expect(mock.refunds.create).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "succeeded", amountSucceeded: 10000, createdRefundId: null });
  });

  it("repeating the call after a successful refund creates no second refund", async () => {
    const { stripe, mock, refunds } = createFakeStripe({});
    await refundPaymentIntent(stripe, "pi_1", "pay-uid");
    await refundPaymentIntent(stripe, "pi_1", "pay-uid");
    expect(mock.refunds.create).toHaveBeenCalledTimes(1);
    expect(refunds).toHaveLength(1);
  });

  it("concurrent calls that both miss the refund get the same refund through the idempotency key", async () => {
    const { stripe, mock, refunds } = createFakeStripe({});
    const [first, second] = await Promise.all([
      refundPaymentIntent(stripe, "pi_1", "pay-uid"),
      refundPaymentIntent(stripe, "pi_1", "pay-uid"),
    ]);
    expect(mock.refunds.create).toHaveBeenCalledTimes(2);
    expect(mock.refunds.create.mock.calls[0][1]).toEqual(mock.refunds.create.mock.calls[1][1]);
    expect(refunds).toHaveLength(1);
    expect(first).toMatchObject({ amountSucceeded: 10000, createdRefundId: "re_new_1" });
    expect(second).toMatchObject({ amountSucceeded: 10000, createdRefundId: "re_new_1" });
  });

  it("refunds only the rest of a partially refunded payment, with a new idempotency key", async () => {
    const { stripe, mock } = createFakeStripe({
      refunds: [{ id: "re_part", amount: 3000, status: "succeeded" }],
    });
    const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
    expect(mock.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 7000 }), {
      idempotencyKey: keyFor(3000, 0),
    });
    expect(outcome).toMatchObject({
      status: "succeeded",
      amountSucceeded: 10000,
      refundIds: ["re_part", "re_new_1"],
    });
  });

  describe("refunds that have not finished", () => {
    it("a new refund Stripe reports as pending is pending, not succeeded", async () => {
      const { stripe } = createFakeStripe({ createStatuses: ["pending"] });
      await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).resolves.toMatchObject({
        status: "pending",
        amountSucceeded: 0,
        amountInProgress: 10000,
      });
    });

    it("repeating while the refund is pending creates no second refund", async () => {
      const { stripe, mock, refunds } = createFakeStripe({ createStatuses: ["pending"] });
      await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      const again = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      expect(mock.refunds.create).toHaveBeenCalledTimes(1);
      expect(refunds).toHaveLength(1);
      expect(again).toMatchObject({ status: "pending", createdRefundId: null });
    });

    it("a repeat after the pending refund succeeded reports succeeded", async () => {
      const { stripe, refunds } = createFakeStripe({ createStatuses: ["pending"] });
      await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      refunds[0].status = "succeeded";
      await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).resolves.toMatchObject({
        status: "succeeded",
        amountSucceeded: 10000,
        amountInProgress: 0,
      });
    });

    it("succeeded and pending parts covering the payment: nothing more is requested, the parts stay apart", async () => {
      const { stripe, mock } = createFakeStripe({
        refunds: [
          { id: "re_done", amount: 3000, status: "succeeded" },
          { id: "re_wait", amount: 7000, status: "pending" },
        ],
      });
      const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      expect(mock.refunds.create).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ status: "pending", amountSucceeded: 3000, amountInProgress: 7000 });
    });

    it("succeeded and pending parts not covering the payment: only the rest is requested", async () => {
      const { stripe, mock } = createFakeStripe({
        refunds: [
          { id: "re_done", amount: 3000, status: "succeeded" },
          { id: "re_wait", amount: 2000, status: "pending" },
        ],
      });
      const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      expect(mock.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000 }), {
        idempotencyKey: keyFor(5000, 0),
      });
      expect(outcome).toMatchObject({ status: "pending", amountSucceeded: 8000, amountInProgress: 2000 });
    });

    it("a refund waiting for an action is reported as requires_action and not requested again", async () => {
      const { stripe, mock } = createFakeStripe({
        refunds: [{ id: "re_action", amount: 10000, status: "requires_action" }],
      });
      await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).resolves.toMatchObject({
        status: "requires_action",
        amountInProgress: 10000,
      });
      expect(mock.refunds.create).not.toHaveBeenCalled();
    });

    it("an unknown refund state counts as in progress, so it is never requested twice", async () => {
      const { stripe, mock } = createFakeStripe({ refunds: [{ id: "re_odd", amount: 10000, status: null }] });
      await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).resolves.toMatchObject({
        status: "pending",
      });
      expect(mock.refunds.create).not.toHaveBeenCalled();
    });
  });

  describe("failed and canceled refunds", () => {
    it("are not counted as returned money; the full amount is requested with a new key", async () => {
      const { stripe, mock } = createFakeStripe({
        refunds: [
          { id: "re_failed", amount: 10000, status: "failed" },
          { id: "re_canceled", amount: 10000, status: "canceled" },
        ],
      });
      const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      expect(mock.refunds.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000 }), {
        idempotencyKey: keyFor(0, 2),
      });
      expect(outcome).toMatchObject({ status: "succeeded", refundIds: ["re_new_1"] });
    });

    it("a refund that fails right away is an error with Stripe's reason", async () => {
      const { stripe } = createFakeStripe({ createStatuses: ["failed"] });
      await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).rejects.toThrow(
        /Refund re_new_1 .* is failed \(expired_or_canceled_card\)/
      );
    });

    it("a new attempt after a failed refund is not stuck replaying the failed one", async () => {
      const { stripe, mock } = createFakeStripe({ createStatuses: ["failed", "succeeded"] });
      await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).rejects.toThrow(/is failed/);
      const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      expect(mock.refunds.create.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
        keyFor(0, 0),
        keyFor(0, 1),
      ]);
      expect(outcome).toMatchObject({ status: "succeeded", createdRefundId: "re_new_2" });
    });

    it("a pending refund that later failed is requested again once", async () => {
      const { stripe, mock, refunds } = createFakeStripe({ createStatuses: ["pending", "succeeded"] });
      await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      refunds[0].status = "failed";
      const outcome = await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      await refundPaymentIntent(stripe, "pi_1", "pay-uid");
      expect(mock.refunds.create).toHaveBeenCalledTimes(2);
      expect(outcome).toMatchObject({ status: "succeeded", amountSucceeded: 10000, refundIds: ["re_new_2"] });
    });
  });

  it("returns nothing_charged for a PaymentIntent that received nothing", async () => {
    const { stripe, mock } = createFakeStripe({ paymentIntent: { status: "succeeded", amount_received: 0 } });
    await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).resolves.toEqual({
      status: "nothing_charged",
      paymentIntentId: "pi_1",
    });
    expect(mock.refunds.create).not.toHaveBeenCalled();
  });

  it("refuses to refund a PaymentIntent that has not succeeded", async () => {
    const { stripe, mock } = createFakeStripe({
      paymentIntent: { status: "processing", amount_received: 0 },
    });
    await expect(refundPaymentIntent(stripe, "pi_1", "pay-uid")).rejects.toThrow(/is processing/);
    expect(mock.refunds.create).not.toHaveBeenCalled();
  });
});

describe("isRetryableStripeError", () => {
  const {
    StripeConnectionError,
    StripeAPIError,
    StripeRateLimitError,
    StripeInvalidRequestError,
    StripeCardError,
  } = Stripe.errors;

  it.each([
    ["connection error", new StripeConnectionError({ type: "api_error", message: "no connection" }), true],
    ["Stripe 500", new StripeAPIError({ type: "api_error", message: "oops", statusCode: 500 }), true],
    [
      "rate limit",
      new StripeRateLimitError({ type: "rate_limit_error", message: "slow down", statusCode: 429 }),
      true,
    ],
    [
      "idempotency key in use (409)",
      new StripeInvalidRequestError({ type: "invalid_request_error", message: "in use", statusCode: 409 }),
      true,
    ],
    [
      "invalid request (400)",
      new StripeInvalidRequestError({ type: "invalid_request_error", message: "bad", statusCode: 400 }),
      false,
    ],
    [
      "card error (402)",
      new StripeCardError({ type: "card_error", message: "declined", statusCode: 402 }),
      false,
    ],
    ["retryable StripeRefundError", new StripeRefundError("x", true), true],
    ["final StripeRefundError", new StripeRefundError("x", false), false],
    ["plain Error", new Error("boom"), false],
  ])("%s → %s", (_label, error, expected) => {
    expect(isRetryableStripeError(error)).toBe(expected);
  });

  it("does not depend on error.type, which minification turns into another class name", () => {
    const minified = new StripeConnectionError({ type: "api_error", message: "no connection" });
    Object.defineProperty(minified, "type", { value: "a" });
    expect(isRetryableStripeError(minified)).toBe(true);
    expect(isRetryableStripeError({ type: "StripeConnectionError" })).toBe(false);
  });
});
