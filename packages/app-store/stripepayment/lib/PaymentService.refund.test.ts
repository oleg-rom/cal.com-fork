/**
 * @vitest-environment node
 */

import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  payment: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@calcom/prisma", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@calcom/features/tasker", () => ({ default: { create: vi.fn() } }));

const mockStripe = vi.hoisted(() => ({
  checkout: { sessions: { retrieve: vi.fn() } },
  paymentIntents: { retrieve: vi.fn() },
  refunds: { list: vi.fn(), create: vi.fn() },
}));
vi.mock("stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stripe")>();
  return {
    default: class {
      static errors = actual.default.errors;
      checkout = mockStripe.checkout;
      paymentIntents = mockStripe.paymentIntents;
      refunds = mockStripe.refunds;
    },
  };
});

import Stripe from "stripe";

import { BuildPaymentService } from "./PaymentService";

const listOf = (refunds: { id: string; amount: number; status: string | null }[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const refund of refunds) yield refund;
  },
});

const paidCheckoutPayment = {
  id: 7,
  uid: "pay-uid-7",
  externalId: "cs_test_paid",
  success: true,
  refunded: false,
  amount: 10000,
  currency: "eur",
  data: { checkoutSessionId: "cs_test_paid", checkoutSessionUrl: "https://checkout.stripe.com/x" },
};

function service() {
  return BuildPaymentService({ key: { default_currency: "eur" } });
}

describe("StripePaymentService.refund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.payment.update.mockImplementation(async ({ data }) => ({ ...paidCheckoutPayment, ...data }));
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      payment_intent: "pi_paid",
      payment_status: "paid",
    });
    mockStripe.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded", amount_received: 10000 });
    mockStripe.refunds.list.mockReturnValue(listOf([]));
    mockStripe.refunds.create.mockResolvedValue({ id: "re_1", amount: 10000, status: "succeeded" });
  });

  it("refunds a Checkout payment against the session's PaymentIntent and records it", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);

    const result = await service().refund(7);

    expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_test_paid");
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_paid" }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("pay-uid-7") })
    );
    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        refunded: true,
        data: expect.objectContaining({
          checkoutSessionId: "cs_test_paid",
          refund: expect.objectContaining({
            status: "succeeded",
            paymentIntentId: "pi_paid",
            refundIds: ["re_1"],
            amountReceived: 10000,
            amountSucceeded: 10000,
            amountInProgress: 0,
          }),
        }),
      },
    });
    expect(result?.refunded).toBe(true);
  });

  it("keeps working for payments that stored the PaymentIntent ID directly", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({
      ...paidCheckoutPayment,
      externalId: "pi_legacy",
      data: {},
    });

    await service().refund(7);

    expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_legacy" }),
      expect.anything()
    );
  });

  it("keeps working for HOLD payments, refunding the PaymentIntent charged for them", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({
      ...paidCheckoutPayment,
      externalId: "seti_hold",
      data: { setupIntent: { id: "seti_hold" }, paymentIntent: { id: "pi_hold" } },
    });

    await service().refund(7);

    expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(mockStripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_hold" }),
      expect.anything()
    );
  });

  it("a pending refund is recorded as pending and does not mark the payment refunded", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);
    mockStripe.refunds.create.mockResolvedValue({ id: "re_wait", amount: 10000, status: "pending" });

    const result = await service().refund(7);

    expect(mockPrisma.payment.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        refunded: false,
        data: expect.objectContaining({
          refund: expect.objectContaining({
            status: "pending",
            refundIds: ["re_wait"],
            amountSucceeded: 0,
            amountInProgress: 10000,
          }),
        }),
      },
    });
    expect(result?.refunded).toBe(false);
  });

  it("re-checking a pending refund creates no second refund and marks the payment once it succeeded", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({
      ...paidCheckoutPayment,
      data: { ...paidCheckoutPayment.data, refund: { status: "pending", refundIds: ["re_wait"] } },
    });
    mockStripe.refunds.list.mockReturnValueOnce(
      listOf([{ id: "re_wait", amount: 10000, status: "pending" }])
    );
    await service().refund(7);
    mockStripe.refunds.list.mockReturnValueOnce(
      listOf([{ id: "re_wait", amount: 10000, status: "succeeded" }])
    );
    const result = await service().refund(7);

    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update.mock.calls.map((call) => call[0].data.refunded)).toEqual([false, true]);
    expect(result?.refunded).toBe(true);
  });

  it("a refund waiting for an action is recorded as requires_action, not refunded", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);
    mockStripe.refunds.list.mockReturnValue(
      listOf([{ id: "re_act", amount: 10000, status: "requires_action" }])
    );

    const result = await service().refund(7);

    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refunded: false,
          data: expect.objectContaining({ refund: expect.objectContaining({ status: "requires_action" }) }),
        }),
      })
    );
    expect(result?.refunded).toBe(false);
  });

  it("Stripe refunded but saving failed: the error says so, and a repeat finds the refund instead of creating one", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);
    mockPrisma.payment.update.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(service().refund(7)).rejects.toMatchObject({
      code: ErrorCode.PaymentRefundFailure,
      message: expect.stringContaining("is succeeded in Stripe (re_1), but saving the result failed"),
      data: { paymentId: 7, retryable: true, refundRequestedInStripe: true },
    });
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();

    mockStripe.refunds.list.mockReturnValue(listOf([{ id: "re_1", amount: 10000, status: "succeeded" }]));
    const result = await service().refund(7);

    expect(mockStripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(result?.refunded).toBe(true);
  });

  it("returns an already refunded payment without calling Stripe", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({ ...paidCheckoutPayment, refunded: true });

    const result = await service().refund(7);

    expect(result?.refunded).toBe(true);
    expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });

  it("marks the payment refunded without a new refund when Stripe already refunded it", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);
    mockStripe.refunds.list.mockReturnValue(
      listOf([{ id: "re_earlier", amount: 10000, status: "succeeded" }])
    );

    await service().refund(7);

    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refunded: true,
          data: expect.objectContaining({ refund: expect.objectContaining({ refundIds: ["re_earlier"] }) }),
        }),
      })
    );
  });

  it("does not touch Stripe refunds or mark anything for a payment that charged nothing", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({ ...paidCheckoutPayment, amount: 0 });
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      payment_intent: null,
      payment_status: "no_payment_required",
    });

    const result = await service().refund(7);

    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result?.refunded).toBe(false);
  });

  it("on a temporary Stripe error keeps refunded=false, records the failure and throws a retryable error", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);
    mockStripe.refunds.create.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({
        type: "api_error",
        message: "An error occurred with our connection to Stripe",
      })
    );

    const error = await service()
      .refund(7)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWithCode);
    expect(error).toMatchObject({
      code: ErrorCode.PaymentRefundFailure,
      data: { paymentId: 7, retryable: true },
    });
    expect((error as ErrorWithCode).data).not.toHaveProperty("refundRequestedInStripe");
    expect((error as Error).message).toMatch(/temporary error/);
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: 7, refunded: false },
      data: {
        data: expect.objectContaining({
          checkoutSessionId: "cs_test_paid",
          refundFailure: expect.objectContaining({
            retryable: true,
            reason: expect.stringContaining("connection"),
          }),
        }),
      },
    });
  });

  it("on a permanent Stripe error records a non-retryable failure", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);
    mockStripe.refunds.create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "Charge has already been refunded.",
        statusCode: 400,
      })
    );

    await expect(service().refund(7)).rejects.toMatchObject({ data: { retryable: false } });
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          data: expect.objectContaining({ refundFailure: expect.objectContaining({ retryable: false }) }),
        },
      })
    );
  });

  it("still reports the Stripe failure when recording it in the database fails too", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(paidCheckoutPayment);
    mockStripe.refunds.create.mockRejectedValue(
      new Stripe.errors.StripeAPIError({ type: "api_error", message: "Stripe is down", statusCode: 503 })
    );
    mockPrisma.payment.updateMany.mockRejectedValue(new Error("database unavailable"));

    await expect(service().refund(7)).rejects.toMatchObject({
      code: ErrorCode.PaymentRefundFailure,
      message: expect.stringContaining("Stripe is down"),
    });
  });

  it("clears an earlier recorded failure once the refund succeeds", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({
      ...paidCheckoutPayment,
      data: { ...paidCheckoutPayment.data, refundFailure: { reason: "earlier", retryable: true } },
    });

    await service().refund(7);

    const written = mockPrisma.payment.update.mock.calls[0][0].data.data;
    expect(written).not.toHaveProperty("refundFailure");
    expect(written).toHaveProperty("refund");
  });

  it("still refuses to refund a payment that never succeeded", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue({ ...paidCheckoutPayment, success: false });
    await expect(service().refund(7)).rejects.toThrow("Unable to refund failed payment");
    expect(mockStripe.refunds.create).not.toHaveBeenCalled();
  });
});
