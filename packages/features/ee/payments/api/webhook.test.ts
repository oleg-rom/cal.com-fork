/**
 * @vitest-environment node
 */

import { BookingStatus } from "@calcom/prisma/enums";
import type { NextApiRequest, NextApiResponse } from "next";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  payment: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  booking: { update: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("micro", () => ({ buffer: vi.fn() }));
vi.mock("@calcom/features/ee/payments/server/stripe", () => ({
  default: { webhooks: { constructEvent: vi.fn() } },
}));
vi.mock("@calcom/features/bookings/lib/EventManager", () => ({
  default: vi.fn(),
  placeholderCreatedEvent: { referencesToCreate: [] },
}));
vi.mock("@calcom/features/bookings/lib/handleConfirmation", () => ({ handleConfirmation: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/handleBookingRequested", () => ({ handleBookingRequested: vi.fn() }));
vi.mock("@calcom/emails/email-manager", () => ({
  sendScheduledEmailsAndSMS: vi.fn(),
  sendOrganizerRequestEmail: vi.fn(),
  sendAttendeeRequestEmailAndSMS: vi.fn(),
}));
vi.mock("@calcom/features/webhooks/lib/getWebhooks", () => ({ default: vi.fn() }));
vi.mock("@calcom/features/webhooks/lib/sendOrSchedulePayload", () => ({ default: vi.fn() }));
vi.mock("@calcom/features/ee/workflows/lib/getAllWorkflowsFromEventType", () => ({
  getAllWorkflowsFromEventType: vi.fn().mockResolvedValue([]),
}));
vi.mock("@calcom/features/ee/workflows/lib/service/WorkflowService", () => ({
  WorkflowService: { scheduleWorkflowsFilteredByTriggerEvent: vi.fn() },
}));
vi.mock("@calcom/features/bookings/lib/payment/getBooking", () => ({ getBooking: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/getAllCredentialsForUsersOnEvent/getAllCredentials", () => ({
  getAllCredentialsIncludeServiceAccountKey: vi.fn().mockResolvedValue([]),
}));
vi.mock("@calcom/features/tasker", () => ({ default: { cancelWithReference: vi.fn() } }));
vi.mock("@calcom/features/ee/billing/credit-service", () => ({
  CreditService: class {
    hasAvailableCredits = vi.fn().mockResolvedValue(true);
  },
}));
vi.mock("@calcom/features/ee/organizations/lib/getBookerUrlServer", () => ({
  getBookerBaseUrl: vi.fn().mockResolvedValue("https://booking.example"),
}));
vi.mock("@calcom/lib/getOrgIdFromMemberOrTeamId", () => ({ default: vi.fn().mockResolvedValue(null) }));
vi.mock("@calcom/lib/getTeamIdFromEventType", () => ({
  getTeamIdFromEventType: vi.fn().mockResolvedValue(null),
}));
vi.mock("@calcom/lib/CalEventParser", () => ({ getVideoCallUrlFromCalEvent: vi.fn().mockReturnValue("") }));
vi.mock("@calcom/features/platform-oauth-client/platform-oauth-client.repository", () => ({
  PlatformOAuthClientRepository: class {
    getByUserId = vi.fn().mockResolvedValue(null);
  },
}));
vi.mock("@calcom/features/platform-oauth-client/get-platform-params", () => ({ getPlatformParams: vi.fn() }));
vi.mock("@calcom/app-store/_utils/getAppActor", () => ({ getAppActor: vi.fn().mockReturnValue({}) }));
vi.mock("@calcom/lib/tracing/factory", () => ({
  distributedTracing: {
    createTrace: vi.fn().mockReturnValue({ traceId: "t", spanId: "s", operation: "stripe_webhook" }),
    updateTrace: vi.fn((trace) => trace),
    getTracingLogger: vi.fn().mockReturnValue({ error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
  },
}));
vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

import { sendScheduledEmailsAndSMS } from "@calcom/emails/email-manager";
import EventManager from "@calcom/features/bookings/lib/EventManager";
import { handleConfirmation } from "@calcom/features/bookings/lib/handleConfirmation";
import { getBooking } from "@calcom/features/bookings/lib/payment/getBooking";
import stripe from "@calcom/features/ee/payments/server/stripe";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import sendPayload from "@calcom/features/webhooks/lib/sendOrSchedulePayload";
import { buffer } from "micro";
import handler, { getCheckoutSessionPaymentState } from "./webhook";

const SESSION_ID = "cs_test_123";
const PAYMENT_ID = 100;
const PAYMENT_UID = "payment-uid-1";
const BOOKING_ID = 42;
const RAW_BODY = '{"id":"evt_test_1","object":"event"}';

type BookingResult = Awaited<ReturnType<typeof getBooking>>;

function buildSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: SESSION_ID,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    amount_total: 11900,
    currency: "eur",
    payment_intent: "pi_test_123",
    metadata: { bookingId: String(BOOKING_ID), paymentUid: PAYMENT_UID },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function buildEvent(type: string, session: Stripe.Checkout.Session): Stripe.Event {
  return {
    id: "evt_test_1",
    object: "event",
    type,
    created: 1_760_000_000,
    data: { object: session },
  } as unknown as Stripe.Event;
}

function storedPayment(overrides: { success?: boolean; bookingStatus?: BookingStatus } = {}) {
  return {
    id: PAYMENT_ID,
    uid: PAYMENT_UID,
    bookingId: BOOKING_ID,
    success: overrides.success ?? false,
    data: { checkoutSessionId: SESSION_ID },
    booking: { status: overrides.bookingStatus ?? BookingStatus.PENDING },
  };
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn(),
    send: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.send.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

async function deliver(event: Stripe.Event) {
  vi.mocked(stripe.webhooks.constructEvent).mockReturnValue(event);
  const req = {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=signature" },
  } as unknown as NextApiRequest;
  const res = mockResponse();
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

function expectNoBookingSideEffects() {
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  expect(handleConfirmation).not.toHaveBeenCalled();
  expect(EventManager).not.toHaveBeenCalled();
  expect(sendScheduledEmailsAndSMS).not.toHaveBeenCalled();
  expect(getWebhooks).not.toHaveBeenCalled();
  expect(sendPayload).not.toHaveBeenCalled();
}

function expectBookingConfirmedOnce() {
  expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  expect(handleConfirmation).toHaveBeenCalledTimes(1);
  expect(getWebhooks).toHaveBeenCalledWith(expect.objectContaining({ triggerEvent: "BOOKING_PAID" }));
  expect(sendPayload).toHaveBeenCalledTimes(1);
}

describe("getCheckoutSessionPaymentState", () => {
  it.each([
    [{ mode: "payment", payment_status: "paid", amount_total: 11900 }, "paid"],
    [{ mode: "payment", payment_status: "unpaid", amount_total: 11900 }, "awaiting_payment"],
    [{ mode: "payment", payment_status: "no_payment_required", amount_total: 0 }, "paid"],
    [{ mode: "payment", payment_status: "no_payment_required", amount_total: 500 }, "not_a_booking_payment"],
    [{ mode: "setup", payment_status: "no_payment_required", amount_total: 0 }, "not_a_booking_payment"],
    [{ mode: "subscription", payment_status: "paid", amount_total: 11900 }, "not_a_booking_payment"],
  ] as const)("%o -> %s", (session, expected) => {
    expect(getCheckoutSessionPaymentState(session)).toBe(expected);
  });
});

describe("Stripe payment webhook: checkout sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
    vi.stubEnv("STRIPE_DIRECT_MODE", undefined);

    vi.mocked(buffer).mockResolvedValue(Buffer.from(RAW_BODY));
    mockPrisma.payment.findFirst.mockResolvedValue(storedPayment());
    mockPrisma.$transaction.mockResolvedValue([
      { id: PAYMENT_ID, externalId: SESSION_ID },
      { status: BookingStatus.ACCEPTED },
    ]);
    vi.mocked(getBooking).mockResolvedValue({
      booking: {
        id: BOOKING_ID,
        uid: "booking-uid",
        userId: 1,
        eventTypeId: 10,
        status: BookingStatus.PENDING,
        location: null,
        smsReminderNumber: null,
        eventType: { id: 10, title: "Consultation", price: 10000, currency: "eur", metadata: {} },
      },
      user: { id: 1, isPlatformManaged: false, credentials: [] },
      evt: { uid: "booking-uid", bookingId: BOOKING_ID, attendees: [{ email: "client@example.com" }] },
      eventType: { id: 10, metadata: {} },
    } as unknown as BookingResult);
    vi.mocked(getWebhooks).mockResolvedValue([
      { id: "wh", subscriberUrl: "https://hooks.example", secret: "s" },
    ] as unknown as Awaited<ReturnType<typeof getWebhooks>>);
    vi.mocked(sendPayload).mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies the signature against the raw request body", async () => {
    await deliver(buildEvent("checkout.session.completed", buildSession()));

    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(RAW_BODY, "t=1,v1=signature", "whsec_test");
  });

  it("completed + paid confirms the booking once", async () => {
    const res = await deliver(buildEvent("checkout.session.completed", buildSession()));

    expect(res.statusCode).toBe(200);
    expectBookingConfirmedOnce();
  });

  it("completed + unpaid (delayed payment method) does not confirm anything", async () => {
    const res = await deliver(
      buildEvent("checkout.session.completed", buildSession({ payment_status: "unpaid" }))
    );

    expect(res.statusCode).toBe(202);
    expect(mockPrisma.payment.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expectNoBookingSideEffects();
  });

  it("completed + no_payment_required with a zero total (100% promotion code) confirms the booking", async () => {
    const res = await deliver(
      buildEvent(
        "checkout.session.completed",
        buildSession({ payment_status: "no_payment_required", amount_total: 0, payment_intent: null })
      )
    );

    expect(res.statusCode).toBe(200);
    expectBookingConfirmedOnce();
  });

  it.each([
    [
      "setup mode",
      { mode: "setup" as const, payment_status: "no_payment_required" as const, amount_total: 0 },
    ],
    ["non-zero total", { payment_status: "no_payment_required" as const, amount_total: 11900 }],
    ["subscription mode", { mode: "subscription" as const }],
  ])("rejects a no_payment_required/non-payment session (%s)", async (_label, overrides) => {
    const res = await deliver(buildEvent("checkout.session.completed", buildSession(overrides)));

    expect(res.statusCode).toBe(202);
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expectNoBookingSideEffects();
  });

  it("async_payment_succeeded confirms the booking once", async () => {
    const res = await deliver(buildEvent("checkout.session.async_payment_succeeded", buildSession()));

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: SESSION_ID } })
    );
    expectBookingConfirmedOnce();
  });

  it("async_payment_failed records the failure without touching the booking", async () => {
    const res = await deliver(
      buildEvent("checkout.session.async_payment_failed", buildSession({ payment_status: "unpaid" }))
    );

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, success: false },
      data: {
        data: expect.objectContaining({
          checkoutSessionId: SESSION_ID,
          asyncPaymentFailure: expect.objectContaining({
            checkoutSessionId: SESSION_ID,
            paymentIntentId: "pi_test_123",
            stripeEventId: "evt_test_1",
          }),
        }),
      },
    });
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expectNoBookingSideEffects();
  });

  it.each([
    BookingStatus.CANCELLED,
    BookingStatus.REJECTED,
  ])("late async success for a %s booking is recorded for manual settlement, not reopened", async (bookingStatus) => {
    mockPrisma.payment.findFirst.mockResolvedValue(storedPayment({ bookingStatus }));

    const res = await deliver(buildEvent("checkout.session.async_payment_succeeded", buildSession()));

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, success: false },
      data: {
        success: true,
        data: expect.objectContaining({
          manualSettlementRequired: expect.objectContaining({
            reason: "paid_after_booking_closed",
            bookingStatus,
            checkoutSessionId: SESSION_ID,
            paymentIntentId: "pi_test_123",
          }),
        }),
      },
    });
    expect(getBooking).not.toHaveBeenCalled();
    expectNoBookingSideEffects();
  });

  it("late async failure after a successful payment changes nothing", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(
      storedPayment({ success: true, bookingStatus: BookingStatus.ACCEPTED })
    );

    const res = await deliver(
      buildEvent("checkout.session.async_payment_failed", buildSession({ payment_status: "unpaid" }))
    );

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expectNoBookingSideEffects();
  });

  it("a sequential redelivery of an already processed session is a no-op", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(
      storedPayment({ success: true, bookingStatus: BookingStatus.ACCEPTED })
    );

    const res = await deliver(buildEvent("checkout.session.completed", buildSession()));

    expect(res.statusCode).toBe(200);
    expect(getBooking).not.toHaveBeenCalled();
    expectNoBookingSideEffects();
  });

  it("does not confirm when session metadata points to a different booking", async () => {
    const res = await deliver(
      buildEvent(
        "checkout.session.completed",
        buildSession({ metadata: { bookingId: "999", paymentUid: PAYMENT_UID } })
      )
    );

    expect(res.statusCode).toBe(202);
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expectNoBookingSideEffects();
  });

  it("returns 204 when no payment exists for the session (existing behaviour)", async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(null);

    const res = await deliver(buildEvent("checkout.session.completed", buildSession()));

    expect(res.statusCode).toBe(204);
    expectNoBookingSideEffects();
  });

  it("returns a retryable 5xx when the database is temporarily unavailable", async () => {
    mockPrisma.payment.findFirst.mockRejectedValue(new Error("connection terminated"));

    const res = await deliver(buildEvent("checkout.session.async_payment_succeeded", buildSession()));

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expectNoBookingSideEffects();
  });
});
