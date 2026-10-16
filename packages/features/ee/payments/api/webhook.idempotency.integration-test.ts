import { randomUUID } from "node:crypto";
import process from "node:process";
import { BookingStatus, PaymentProcessingStatus } from "@calcom/prisma/enums";
import type { NextApiRequest, NextApiResponse } from "next";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end through the real webhook handler, handlePaymentSuccess and PostgreSQL. Only the outside
// world is mocked: Stripe signature verification, booking/calendar/video/email/webhook delivery.
// Runs only against the throwaway local database so it can never touch shared data.
const isIsolatedTestDatabase = /@(127\.0\.0\.1|localhost):\d+\/calcom_s2_test$/.test(
  process.env.DATABASE_URL ?? ""
);

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
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: vi.fn(() => mockLog) },
}));

import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { sendScheduledEmailsAndSMS } from "@calcom/emails/email-manager";
import EventManager from "@calcom/features/bookings/lib/EventManager";
import { handleConfirmation } from "@calcom/features/bookings/lib/handleConfirmation";
import { getBooking } from "@calcom/features/bookings/lib/payment/getBooking";
import {
  PaymentProcessingClaimLostError,
  PaymentProcessingRepository,
} from "@calcom/features/bookings/repositories/PaymentProcessingRepository";
import stripe from "@calcom/features/ee/payments/server/stripe";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import sendPayload from "@calcom/features/webhooks/lib/sendOrSchedulePayload";
import prisma from "@calcom/prisma";
import { buffer } from "micro";

import handler from "./webhook";

type BookingResult = Awaited<ReturnType<typeof getBooking>>;

type Fixture = { bookingId: number; paymentId: number; paymentUid: string; externalId: string };

const expiredLease = new Date("2000-01-01T00:00:00Z");
let fixtureSlot = 0;

async function createFixture({
  externalId = `cs_test_${randomUUID()}`,
  bookingStatus = BookingStatus.PENDING,
  paymentSuccess = false,
}: {
  externalId?: string;
  bookingStatus?: BookingStatus;
  paymentSuccess?: boolean;
} = {}): Promise<Fixture> {
  // Accepted bookings get an idempotency key derived from their time slot, so every fixture needs its own slot.
  const startTime = new Date(
    Date.UTC(2030, 0, 1) + (Date.now() % 1_000_000) * 3_600_000 + fixtureSlot++ * 60_000
  );
  const booking = await prisma.booking.create({
    data: {
      uid: `s2-int-${randomUUID()}`,
      title: "Synthetic paid booking",
      startTime,
      endTime: new Date(startTime.getTime() + 3_600_000),
      status: bookingStatus,
      paid: paymentSuccess,
    },
    select: { id: true },
  });
  const paymentUid = randomUUID();
  const payment = await prisma.payment.create({
    data: {
      uid: paymentUid,
      bookingId: booking.id,
      amount: 10000,
      fee: 0,
      currency: "eur",
      success: paymentSuccess,
      refunded: false,
      data: { checkoutSessionId: externalId },
      externalId,
    },
    select: { id: true },
  });
  return { bookingId: booking.id, paymentId: payment.id, paymentUid, externalId };
}

function checkoutEvent(
  type: string,
  fixture: Fixture,
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Event {
  return {
    id: `evt_${randomUUID()}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: fixture.externalId,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        amount_total: 11900,
        payment_intent: "pi_test_123",
        metadata: { bookingId: String(fixture.bookingId), paymentUid: fixture.paymentUid },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function paymentIntentEvent(fixture: Fixture): Stripe.Event {
  return {
    id: `evt_${randomUUID()}`,
    object: "event",
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: fixture.externalId, object: "payment_intent" } },
  } as unknown as Stripe.Event;
}

async function deliver(event: Stripe.Event): Promise<number> {
  const res = { statusCode: 200, status: vi.fn(), send: vi.fn(), json: vi.fn() };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.send.mockReturnValue(res);
  res.json.mockReturnValue(res);
  const req = {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=sig" },
    event,
  } as unknown as NextApiRequest;
  await handler(req, res as unknown as NextApiResponse);
  return res.statusCode;
}

async function processingRow(paymentId: number) {
  return prisma.paymentProcessing.findUnique({ where: { paymentId } });
}

describe.skipIf(!isIsolatedTestDatabase)("Stripe webhook idempotency (PostgreSQL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
    vi.stubEnv("STRIPE_DIRECT_MODE", undefined);

    // Each request carries its own event, as Stripe would send it.
    vi.mocked(buffer).mockResolvedValue(Buffer.from("{}"));
    vi.mocked(stripe.webhooks.constructEvent).mockImplementation(() => {
      throw new Error("constructEvent must be bound to a request");
    });

    vi.mocked(getBooking).mockImplementation(async (bookingId: number) => {
      const current = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { id: true, uid: true, status: true },
      });
      return {
        booking: {
          ...current,
          userId: null,
          eventTypeId: null,
          location: null,
          smsReminderNumber: null,
          eventType: { id: 10, title: "Consultation", price: 10000, currency: "eur", metadata: {} },
        },
        user: { id: 1, isPlatformManaged: false, credentials: [] },
        evt: { uid: current.uid, bookingId, attendees: [{ email: "client@example.test" }] },
        eventType: { id: 10, metadata: {} },
      } as unknown as BookingResult;
    });
    vi.mocked(handleConfirmation).mockImplementation(async ({ bookingId }) => {
      await prisma.booking.update({ where: { id: bookingId }, data: { status: BookingStatus.ACCEPTED } });
    });
    vi.mocked(getWebhooks).mockResolvedValue([
      { id: "wh", subscriberUrl: "https://hooks.example.test", secret: "s" },
    ] as unknown as Awaited<ReturnType<typeof getWebhooks>>);
    vi.mocked(sendPayload).mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { uid: { startsWith: "s2-int-" } } });
  });

  // Binds the signature mock to the event of each request so concurrent deliveries stay distinct.
  async function send(event: Stripe.Event): Promise<number> {
    vi.mocked(stripe.webhooks.constructEvent).mockImplementationOnce(() => event);
    return deliver(event);
  }

  async function expectConfirmedOnce(fixture: Fixture) {
    expect(handleConfirmation).toHaveBeenCalledTimes(1);
    expect(sendPayload).toHaveBeenCalledTimes(1);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } });
    expect(payment.success).toBe(true);
    expect(booking).toMatchObject({ paid: true, status: BookingStatus.ACCEPTED });
    expect(await processingRow(fixture.paymentId)).toMatchObject({
      status: PaymentProcessingStatus.COMPLETED,
      claimToken: null,
      leaseExpiresAt: null,
    });
  }

  it("sequential redelivery confirms once", async () => {
    const fixture = await createFixture();

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);
    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    await expectConfirmedOnce(fixture);
  });

  it("parallel deliveries of different events for one payment confirm once; the loser is told to retry", async () => {
    const fixture = await createFixture();
    vi.mocked(handleConfirmation).mockImplementation(async ({ bookingId }) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await prisma.booking.update({ where: { id: bookingId }, data: { status: BookingStatus.ACCEPTED } });
    });

    const statuses = await Promise.all([
      send(checkoutEvent("checkout.session.completed", fixture)),
      send(checkoutEvent("checkout.session.async_payment_succeeded", fixture)),
      send(checkoutEvent("checkout.session.completed", fixture)),
    ]);

    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);
    expect(await send(checkoutEvent("checkout.session.async_payment_succeeded", fixture))).toBe(200);
    await expectConfirmedOnce(fixture);
  });

  it("parallel payment_intent.succeeded deliveries confirm once", async () => {
    const fixture = await createFixture({ externalId: `pi_test_${randomUUID()}` });

    const statuses = await Promise.all(Array.from({ length: 5 }, () => send(paymentIntentEvent(fixture))));

    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    await expectConfirmedOnce(fixture);
  });

  it("a temporary error is retried without repeating finished steps", async () => {
    const fixture = await createFixture();
    vi.mocked(handleConfirmation).mockRejectedValueOnce(new Error("SMTP connection reset"));

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBeGreaterThanOrEqual(500);
    expect(await processingRow(fixture.paymentId)).toMatchObject({
      status: PaymentProcessingStatus.FAILED,
      claimToken: null,
      lastError: "Error: SMTP connection reset",
      paymentRecordedAt: expect.any(Date),
      bookingPaidCompletedAt: expect.any(Date),
      confirmationCompletedAt: null,
    });

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    expect(handleConfirmation).toHaveBeenCalledTimes(2);
    expect(sendPayload).toHaveBeenCalledTimes(1);
    const row = await processingRow(fixture.paymentId);
    expect(row).toMatchObject({ status: PaymentProcessingStatus.COMPLETED, attempts: 2 });
  });

  it("a worker that died right after claiming blocks retries only until its lease expires", async () => {
    const fixture = await createFixture();
    await prisma.paymentProcessing.create({
      data: {
        paymentId: fixture.paymentId,
        status: PaymentProcessingStatus.PROCESSING,
        claimToken: "dead-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        attempts: 1,
      },
    });

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(409);
    expect(handleConfirmation).not.toHaveBeenCalled();
    expect(sendPayload).not.toHaveBeenCalled();

    await prisma.paymentProcessing.update({
      where: { paymentId: fixture.paymentId },
      data: { leaseExpiresAt: expiredLease },
    });
    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);
    await expectConfirmedOnce(fixture);
  });

  it("resumes after a crash between BOOKING_PAID and the confirmation without resending BOOKING_PAID", async () => {
    const fixture = await createFixture({ bookingStatus: BookingStatus.ACCEPTED, paymentSuccess: true });
    const now = new Date();
    await prisma.paymentProcessing.create({
      data: {
        paymentId: fixture.paymentId,
        status: PaymentProcessingStatus.PROCESSING,
        claimToken: "dead-worker",
        leaseExpiresAt: expiredLease,
        attempts: 1,
        bookingWasAcceptedBeforePayment: false,
        paymentRecordedAt: now,
        bookingPaidStartedAt: now,
        bookingPaidCompletedAt: now,
        confirmationStartedAt: now,
      },
    });

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    expect(sendPayload).not.toHaveBeenCalled();
    expect(handleConfirmation).toHaveBeenCalledTimes(1);
    expect(EventManager).not.toHaveBeenCalled();
    expect(await processingRow(fixture.paymentId)).toMatchObject({
      status: PaymentProcessingStatus.COMPLETED,
    });
  });

  it("re-sends BOOKING_PAID when the crash interrupted that step (documented duplicate window)", async () => {
    const fixture = await createFixture({ bookingStatus: BookingStatus.PENDING, paymentSuccess: true });
    const now = new Date();
    await prisma.paymentProcessing.create({
      data: {
        paymentId: fixture.paymentId,
        status: PaymentProcessingStatus.PROCESSING,
        claimToken: "dead-worker",
        leaseExpiresAt: expiredLease,
        attempts: 1,
        bookingWasAcceptedBeforePayment: false,
        paymentRecordedAt: now,
        bookingPaidStartedAt: now,
        bookingPaidStartCount: 1,
      },
    });

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(handleConfirmation).toHaveBeenCalledTimes(1);
    // StartCount > 1 is the evidence that BOOKING_PAID may have been delivered twice.
    expect(await processingRow(fixture.paymentId)).toMatchObject({
      bookingPaidStartCount: 2,
      confirmationStartCount: 1,
    });
  });

  it("a completed step keeps its StartedAt; only StartCount > 1 indicates a repeated step", async () => {
    const fixture = await createFixture();

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    expect(await processingRow(fixture.paymentId)).toMatchObject({
      status: PaymentProcessingStatus.COMPLETED,
      attempts: 1,
      bookingPaidStartedAt: expect.any(Date),
      bookingPaidCompletedAt: expect.any(Date),
      bookingPaidStartCount: 1,
      confirmationStartedAt: expect.any(Date),
      confirmationCompletedAt: expect.any(Date),
      confirmationStartCount: 1,
      calendarStartCount: 0,
    });
  });

  describe("lease expiry during a long external call", () => {
    const shortTiming = { leaseMs: 400, heartbeatMs: 100 };

    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    async function settle(run: Promise<never>): Promise<unknown> {
      try {
        await run;
        return "resolved";
      } catch (error) {
        if (error instanceof PaymentProcessingClaimLostError) return error;
        if (error && typeof error === "object" && "statusCode" in error) return error.statusCode;
        return error;
      }
    }

    function confirm(fixture: Fixture): Promise<never> {
      return handlePaymentSuccess(
        {
          paymentId: fixture.paymentId,
          bookingId: fixture.bookingId,
          appSlug: "stripe",
          traceContext: { traceId: "t", spanId: "s", operation: "test" },
        },
        shortTiming
      );
    }

    it("a live worker keeps its lease through a call longer than the lease, so no second worker starts", async () => {
      const fixture = await createFixture();
      const slowCall = deferred();
      vi.mocked(handleConfirmation).mockImplementationOnce(async ({ bookingId }) => {
        await slowCall.promise;
        await prisma.booking.update({ where: { id: bookingId }, data: { status: BookingStatus.ACCEPTED } });
      });

      const workerA = settle(confirm(fixture));
      await vi.waitFor(() => expect(handleConfirmation).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, shortTiming.leaseMs * 3));

      expect(await settle(confirm(fixture))).toBe(409);

      slowCall.resolve();
      expect(await workerA).toBe(200);
      expect(handleConfirmation).toHaveBeenCalledTimes(1);
      expect(await processingRow(fixture.paymentId)).toMatchObject({
        status: PaymentProcessingStatus.COMPLETED,
        confirmationStartCount: 1,
      });
    });

    it("if heartbeats fail past the lease, a second worker repeats the in-flight step and the stale worker is fenced", async () => {
      const fixture = await createFixture();
      vi.spyOn(PaymentProcessingRepository.prototype, "renewLease").mockRejectedValue(
        new Error("database unreachable")
      );
      const slowCall = deferred();
      vi.mocked(handleConfirmation).mockImplementationOnce(async ({ bookingId }) => {
        await slowCall.promise;
        await prisma.booking.update({ where: { id: bookingId }, data: { status: BookingStatus.ACCEPTED } });
      });

      const workerA = settle(confirm(fixture));
      await vi.waitFor(() => expect(handleConfirmation).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, shortTiming.leaseMs * 2));

      // Worker B takes over the expired lease and performs the confirmation step itself.
      expect(await settle(confirm(fixture))).toBe(200);
      expect(handleConfirmation).toHaveBeenCalledTimes(2);

      // Worker A's external call finishes afterwards: it can no longer write progress or complete.
      slowCall.resolve();
      expect(await workerA).toBeInstanceOf(PaymentProcessingClaimLostError);

      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(await processingRow(fixture.paymentId)).toMatchObject({
        status: PaymentProcessingStatus.COMPLETED,
        attempts: 2,
        bookingPaidStartCount: 1,
        confirmationStartCount: 2,
        lastError: null,
      });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('was lost while step "confirmation" ran')
      );
    });
  });

  describe("classification of successful payments without a processing row", () => {
    it("the processing row is committed before the payment is marked successful", async () => {
      const fixture = await createFixture();
      const observed: { rowStatus: string | null; paymentSuccess: boolean | null } = {
        rowStatus: null,
        paymentSuccess: null,
      };
      const defaultGetBooking = vi.mocked(getBooking).getMockImplementation();
      vi.mocked(getBooking).mockImplementationOnce(async (bookingId: number) => {
        // Runs after the claim and before the payment transaction; read through a separate query.
        const [row, payment] = await Promise.all([
          processingRow(fixture.paymentId),
          prisma.payment.findUniqueOrThrow({ where: { id: fixture.paymentId }, select: { success: true } }),
        ]);
        observed.rowStatus = row?.status ?? null;
        observed.paymentSuccess = payment.success;
        if (!defaultGetBooking) throw new Error("getBooking mock missing");
        return defaultGetBooking(bookingId);
      });

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

      expect(observed).toEqual({ rowStatus: PaymentProcessingStatus.PROCESSING, paymentSuccess: false });
    });

    it("an error right after the payment transaction is resumed, not mistaken for a pre-existing payment", async () => {
      const fixture = await createFixture();
      vi.spyOn(PaymentProcessingRepository.prototype, "markPaymentRecorded").mockRejectedValueOnce(
        new Error("process died")
      );

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBeGreaterThanOrEqual(500);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } })).success).toBe(
        true
      );
      expect(await processingRow(fixture.paymentId)).toMatchObject({
        status: PaymentProcessingStatus.FAILED,
        paymentRecordedAt: null,
      });
      expect(handleConfirmation).not.toHaveBeenCalled();

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);
      await expectConfirmedOnce(fixture);
    });

    it("a crash right after the payment transaction (no release) is resumed after the lease expires", async () => {
      const fixture = await createFixture({ paymentSuccess: true });
      await prisma.paymentProcessing.create({
        data: {
          paymentId: fixture.paymentId,
          status: PaymentProcessingStatus.PROCESSING,
          claimToken: "dead-worker",
          leaseExpiresAt: expiredLease,
          attempts: 1,
          bookingWasAcceptedBeforePayment: false,
        },
      });

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);
      await expectConfirmedOnce(fixture);
    });
  });

  it("BOOKING_PAID keeps its contract and, for an already accepted booking, follows the calendar step", async () => {
    const fixture = await createFixture({ bookingStatus: BookingStatus.ACCEPTED });
    const videoCallData = {
      type: "zoom_video",
      id: "8812345",
      password: "pw",
      url: "https://zoom.example/j/8812345",
    };
    const create = vi.fn(async (event: { videoCallData?: unknown; iCalUID?: string }) => {
      // The real EventManager enriches the event it is given.
      event.videoCallData = videoCallData;
      event.iCalUID = "ical-uid-1";
      return {
        referencesToCreate: [
          { type: "zoom_video", uid: "8812345", meetingId: "8812345", meetingUrl: videoCallData.url },
        ],
      };
    });
    vi.mocked(EventManager).mockImplementation(function eventManagerMock() {
      return { create } as unknown as EventManager;
    });

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendPayload).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(sendPayload).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendScheduledEmailsAndSMS).mock.invocationCallOrder[0]
    );
    expect(sendPayload).toHaveBeenCalledWith(
      "s",
      "BOOKING_PAID",
      expect.any(String),
      expect.objectContaining({ subscriberUrl: "https://hooks.example.test" }),
      expect.objectContaining({
        uid: expect.any(String),
        bookingId: fixture.bookingId,
        eventTypeId: 10,
        status: BookingStatus.ACCEPTED,
        paymentId: fixture.paymentId,
        eventTitle: "Consultation",
        price: 10000,
        currency: "eur",
        attendees: [expect.objectContaining({ email: "client@example.test" })],
        videoCallData,
        iCalUID: "ical-uid-1",
        metadata: {
          identifier: "cal.com",
          bookingId: fixture.bookingId,
          eventTypeId: 10,
          bookerEmail: "client@example.test",
          eventTitle: "Consultation",
          externalId: fixture.externalId,
        },
      })
    );
    expect(sendScheduledEmailsAndSMS).toHaveBeenCalledWith(
      expect.objectContaining({ videoCallData }),
      undefined,
      undefined,
      undefined,
      {}
    );
    expect(await prisma.bookingReference.findMany({ where: { bookingId: fixture.bookingId } })).toEqual([
      expect.objectContaining({ type: "zoom_video", meetingId: "8812345" }),
    ]);
    expect(await processingRow(fixture.paymentId)).toMatchObject({
      calendarStartCount: 1,
      calendarCompletedAt: expect.any(Date),
      bookingPaidStartCount: 1,
      confirmationStartCount: 1,
    });
  });

  describe("resuming after the calendar step keeps the meeting details", () => {
    const videoCallData = {
      type: "daily_video",
      id: "room-42",
      password: "pw-42",
      url: "https://meet.example.test/room-42",
    };
    const meetingDetails = {
      videoCallData,
      iCalUID: "ical-uid-42",
      location: "integrations:daily",
      responses: expect.objectContaining({
        location: expect.objectContaining({ value: { optionValue: "", value: "integrations:daily" } }),
      }),
    };

    function mockEnrichingEventManager() {
      // Like the real EventManager: Meet without a Google destination falls back to Cal Video, and the
      // created meeting is written into the event object it receives.
      const create = vi.fn(
        async (event: {
          location?: string | null;
          videoCallData?: unknown;
          iCalUID?: string | null;
          responses?: Record<string, unknown>;
        }) => {
          event.location = "integrations:daily";
          event.videoCallData = videoCallData;
          event.iCalUID = "ical-uid-42";
          if (event.responses) {
            event.responses.location = { value: { optionValue: "", value: "integrations:daily" } };
          }
          return {
            referencesToCreate: [
              { type: "daily_video", uid: "room-42", meetingId: "room-42", meetingUrl: videoCallData.url },
            ],
          };
        }
      );
      vi.mocked(EventManager).mockImplementation(function eventManagerMock() {
        return { create } as unknown as EventManager;
      });
      return create;
    }

    function bookingWithMeetLocation() {
      const defaultGetBooking = vi.mocked(getBooking).getMockImplementation();
      vi.mocked(getBooking).mockImplementation(async (bookingId: number) => {
        if (!defaultGetBooking) throw new Error("getBooking mock missing");
        const result = await defaultGetBooking(bookingId);
        // A fresh event per call, as getBooking builds it from the database on every delivery.
        return {
          ...result,
          evt: {
            ...result.evt,
            location: "integrations:google:meet",
            responses: {
              name: { label: "Name", value: "Client" },
              location: { value: { optionValue: "", value: "integrations:google:meet" } },
            },
          },
        } as unknown as BookingResult;
      });
    }

    it("an interruption before BOOKING_PAID resumes without re-creating the meeting", async () => {
      const fixture = await createFixture({ bookingStatus: BookingStatus.ACCEPTED });
      const create = mockEnrichingEventManager();
      bookingWithMeetLocation();
      const markStepStarted = PaymentProcessingRepository.prototype.markStepStarted;
      let interrupted = false;
      vi.spyOn(PaymentProcessingRepository.prototype, "markStepStarted").mockImplementation(async function (
        this: PaymentProcessingRepository,
        lease
      ) {
        if (lease.step === "bookingPaid" && !interrupted) {
          interrupted = true;
          throw new Error("process died before BOOKING_PAID");
        }
        return markStepStarted.call(this, lease);
      });

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBeGreaterThanOrEqual(500);
      const afterInterruption = await processingRow(fixture.paymentId);
      expect(afterInterruption).toMatchObject({
        calendarCompletedAt: expect.any(Date),
        bookingPaidStartedAt: null,
        bookingPaidCompletedAt: null,
      });
      // Only the meeting enrichment is stored: no attendee data, no responses.
      expect(afterInterruption?.calendarResult).toEqual({
        videoCallData,
        iCalUID: "ical-uid-42",
        location: "integrations:daily",
      });
      expect(sendPayload).not.toHaveBeenCalled();

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

      expect(create).toHaveBeenCalledTimes(1);
      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(sendPayload).toHaveBeenCalledWith(
        "s",
        "BOOKING_PAID",
        expect.any(String),
        expect.anything(),
        expect.objectContaining({
          ...meetingDetails,
          bookingId: fixture.bookingId,
          paymentId: fixture.paymentId,
        })
      );
      expect(sendScheduledEmailsAndSMS).toHaveBeenCalledTimes(1);
      expect(sendScheduledEmailsAndSMS).toHaveBeenCalledWith(
        expect.objectContaining(meetingDetails),
        undefined,
        undefined,
        undefined,
        {}
      );
      expect(await prisma.bookingReference.count({ where: { bookingId: fixture.bookingId } })).toBe(1);
      expect(await processingRow(fixture.paymentId)).toMatchObject({
        status: PaymentProcessingStatus.COMPLETED,
        calendarStartCount: 1,
        bookingPaidStartCount: 1,
        confirmationStartCount: 1,
      });
    });

    it("an interruption after BOOKING_PAID resends the confirmation email with the meeting details", async () => {
      const fixture = await createFixture({ bookingStatus: BookingStatus.ACCEPTED });
      const create = mockEnrichingEventManager();
      bookingWithMeetLocation();
      vi.mocked(sendScheduledEmailsAndSMS).mockRejectedValueOnce(new Error("SMTP unavailable"));

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBeGreaterThanOrEqual(500);
      expect(await processingRow(fixture.paymentId)).toMatchObject({
        status: PaymentProcessingStatus.FAILED,
        calendarCompletedAt: expect.any(Date),
        bookingPaidCompletedAt: expect.any(Date),
        confirmationCompletedAt: null,
      });

      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

      expect(create).toHaveBeenCalledTimes(1);
      expect(sendPayload).toHaveBeenCalledTimes(1);
      expect(sendScheduledEmailsAndSMS).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sendScheduledEmailsAndSMS).mock.calls[1][0]).toEqual(
        expect.objectContaining(meetingDetails)
      );
      expect(await processingRow(fixture.paymentId)).toMatchObject({
        status: PaymentProcessingStatus.COMPLETED,
        calendarStartCount: 1,
        confirmationStartCount: 2,
      });
    });
  });

  it("BOOKING_PAID payload for a pending paid booking carries the contract fields", async () => {
    const fixture = await createFixture();

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    expect(vi.mocked(sendPayload).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(handleConfirmation).mock.invocationCallOrder[0]
    );
    expect(sendPayload).toHaveBeenCalledWith(
      "s",
      "BOOKING_PAID",
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        bookingId: fixture.bookingId,
        eventTypeId: 10,
        status: BookingStatus.ACCEPTED,
        paymentId: fixture.paymentId,
        metadata: expect.objectContaining({ identifier: "cal.com", externalId: fixture.externalId }),
      })
    );
  });

  it("keeps the path chosen before the crash for a booking that was already accepted", async () => {
    const fixture = await createFixture({ bookingStatus: BookingStatus.ACCEPTED });
    vi.mocked(EventManager).mockImplementation(function eventManagerMock() {
      return { create: vi.fn().mockResolvedValue({ referencesToCreate: [] }) } as unknown as EventManager;
    });

    const status = await send(checkoutEvent("checkout.session.completed", fixture));
    expect({ status, lastError: (await processingRow(fixture.paymentId))?.lastError ?? null }).toEqual({
      status: 200,
      lastError: null,
    });

    expect(handleConfirmation).not.toHaveBeenCalled();
    expect(EventManager).toHaveBeenCalledTimes(1);
    expect(sendScheduledEmailsAndSMS).toHaveBeenCalledTimes(1);
    expect(await processingRow(fixture.paymentId)).toMatchObject({ bookingWasAcceptedBeforePayment: true });
  });

  it("does not re-confirm payments that succeeded before coordination existed", async () => {
    const fixture = await createFixture({ bookingStatus: BookingStatus.ACCEPTED, paymentSuccess: true });

    expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

    expect(getBooking).not.toHaveBeenCalled();
    expect(sendPayload).not.toHaveBeenCalled();
    expect(await processingRow(fixture.paymentId)).toBeNull();
  });

  describe("S1 behaviour is preserved", () => {
    it("completed + unpaid confirms nothing and creates no processing row", async () => {
      const fixture = await createFixture();

      expect(
        await send(checkoutEvent("checkout.session.completed", fixture, { payment_status: "unpaid" }))
      ).toBe(202);

      expect(handleConfirmation).not.toHaveBeenCalled();
      expect(await processingRow(fixture.paymentId)).toBeNull();
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } })).success).toBe(
        false
      );
    });

    it("a zero-total no_payment_required session confirms once", async () => {
      const fixture = await createFixture();

      const event = checkoutEvent("checkout.session.completed", fixture, {
        payment_status: "no_payment_required",
        amount_total: 0,
        payment_intent: null,
      });
      expect(await send(event)).toBe(200);
      await expectConfirmedOnce(fixture);
    });

    it("a late success for a cancelled booking is flagged for settlement and never confirmed", async () => {
      const fixture = await createFixture({ bookingStatus: BookingStatus.CANCELLED });

      const statuses = await Promise.all([
        send(checkoutEvent("checkout.session.async_payment_succeeded", fixture)),
        send(checkoutEvent("checkout.session.async_payment_succeeded", fixture)),
      ]);

      expect(statuses).toEqual([200, 200]);
      expect(handleConfirmation).not.toHaveBeenCalled();
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });
      expect(payment.success).toBe(true);
      expect(payment.data).toMatchObject({
        manualSettlementRequired: { reason: "paid_after_booking_closed" },
      });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })).status).toBe(
        BookingStatus.CANCELLED
      );
      expect(await processingRow(fixture.paymentId)).toBeNull();
    });

    it("a late async failure after the confirmation changes nothing", async () => {
      const fixture = await createFixture();
      expect(await send(checkoutEvent("checkout.session.completed", fixture))).toBe(200);

      expect(
        await send(
          checkoutEvent("checkout.session.async_payment_failed", fixture, { payment_status: "unpaid" })
        )
      ).toBe(200);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.paymentId } });
      expect(payment.success).toBe(true);
      expect(payment.data).not.toHaveProperty("asyncPaymentFailure");
      await expectConfirmedOnce(fixture);
    });
  });
});
