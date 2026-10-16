import { randomUUID } from "node:crypto";

import { eventTypeAppMetadataOptionalSchema } from "@calcom/app-store/zod-utils";
import { sendScheduledEmailsAndSMS } from "@calcom/emails/email-manager";
import EventManager, { placeholderCreatedEvent } from "@calcom/features/bookings/lib/EventManager";
import { doesBookingRequireConfirmation } from "@calcom/features/bookings/lib/doesBookingRequireConfirmation";
import { getAllCredentialsIncludeServiceAccountKey } from "@calcom/features/bookings/lib/getAllCredentialsForUsersOnEvent/getAllCredentials";
import { handleBookingRequested } from "@calcom/features/bookings/lib/handleBookingRequested";
import { handleConfirmation } from "@calcom/features/bookings/lib/handleConfirmation";
import { getBooking } from "@calcom/features/bookings/lib/payment/getBooking";
import {
  PaymentProcessingClaimLostError,
  type PaymentProcessingLease,
  PaymentProcessingRepository,
  type PaymentProcessingState,
  type PaymentProcessingStep,
} from "@calcom/features/bookings/repositories/PaymentProcessingRepository";
import { CreditService } from "@calcom/features/ee/billing/credit-service";
import { getBookerBaseUrl } from "@calcom/features/ee/organizations/lib/getBookerUrlServer";
import { getAllWorkflowsFromEventType } from "@calcom/features/ee/workflows/lib/getAllWorkflowsFromEventType";
import { WorkflowService } from "@calcom/features/ee/workflows/lib/service/WorkflowService";
import { getPlatformParams } from "@calcom/features/platform-oauth-client/get-platform-params";
import { PlatformOAuthClientRepository } from "@calcom/features/platform-oauth-client/platform-oauth-client.repository";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import sendPayload from "@calcom/features/webhooks/lib/sendOrSchedulePayload";
import type { EventPayloadType, EventTypeInfo } from "@calcom/features/webhooks/lib/sendPayload";
import { getVideoCallUrlFromCalEvent } from "@calcom/lib/CalEventParser";
import getOrgIdFromMemberOrTeamId from "@calcom/lib/getOrgIdFromMemberOrTeamId";
import { getTeamIdFromEventType } from "@calcom/lib/getTeamIdFromEventType";
import tasker from "@calcom/features/tasker";
import { HttpError as HttpCode } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { TraceContext } from "@calcom/lib/tracing";
import { distributedTracing } from "@calcom/lib/tracing/factory";
import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { BookingStatus, WebhookTriggerEvents, WorkflowTriggerEvents } from "@calcom/prisma/enums";
import type { EventTypeMetadata } from "@calcom/prisma/zod-utils";
import type { CalendarEvent } from "@calcom/types/Calendar";
import { z } from "zod";

import { getAppActor } from "../getAppActor";

const log = logger.getSubLogger({ prefix: ["[handlePaymentSuccess]"] });

// A live worker renews its lease every HEARTBEAT_MS while an external call is running, so the lease
// only has to outlive a missed heartbeat or two. It bounds how long a crashed worker blocks the next
// delivery, not how long a healthy step may take.
const PAYMENT_PROCESSING_LEASE_MS = 2 * 60 * 1000;
const PAYMENT_PROCESSING_HEARTBEAT_MS = 20 * 1000;

type HandlePaymentSuccessParams = {
  paymentId: number;
  appSlug: string;
  bookingId: number;
  traceContext: TraceContext;
};

type PaymentProcessingTiming = { leaseMs: number; heartbeatMs: number };

type StepRunner = (
  step: PaymentProcessingStep,
  progress: { startedAt: Date | null; completedAt: Date | null },
  action: () => Promise<void>,
  getStepResult?: () => CalendarStepResult | undefined
) => Promise<void>;

// Only what EventManager.create adds to the event and BOOKING_PAID/emails need: meeting link data,
// the calendar iCalUID and a location the step replaced (always an integration id, never an address).
const calendarStepResultSchema = z.object({
  videoCallData: z
    .object({ type: z.string(), id: z.string(), password: z.string(), url: z.string() })
    .optional(),
  iCalUID: z.string().optional(),
  location: z.string().optional(),
});

type CalendarStepResult = z.infer<typeof calendarStepResultSchema>;

function captureCalendarStepResult(
  evt: CalendarEvent,
  locationBefore: string | null | undefined
): CalendarStepResult {
  const result: CalendarStepResult = {};
  if (evt.videoCallData) {
    result.videoCallData = {
      type: evt.videoCallData.type,
      id: String(evt.videoCallData.id ?? ""),
      password: evt.videoCallData.password ?? "",
      url: evt.videoCallData.url ?? "",
    };
  }
  if (evt.iCalUID) result.iCalUID = evt.iCalUID;
  if (evt.location && evt.location !== locationBefore) result.location = evt.location;
  return result;
}

function restoreCalendarStepResult(evt: CalendarEvent, stored: unknown, paymentId: number): void {
  const parsed = calendarStepResultSchema.safeParse(stored);
  if (!parsed.success) {
    log.warn(
      `Stored calendar step result for payment ${paymentId} is unreadable; meeting details may be missing`
    );
    return;
  }
  const { videoCallData, iCalUID, location } = parsed.data;
  if (location) evt.location = location;
  if (iCalUID) evt.iCalUID = iCalUID;
  if (videoCallData) {
    evt.videoCallData = videoCallData;
    // Mirrors EventManager.create, which puts the meeting location into the responses sent to webhooks.
    if (evt.location && evt.responses) {
      evt.responses.location = {
        ...(evt.responses.location ?? {}),
        value: {
          optionValue: "",
          value: evt.location,
        },
      };
    }
  }
}

/**
 * Runs one external step under the lease. The heartbeat keeps a slow but healthy worker from being
 * taken over; it cannot stop a call that is already in flight, so if renewal fails for longer than the
 * lease another worker may repeat this step. That case is logged here when the stale worker finishes.
 */
function createStepRunner(
  processingRepository: PaymentProcessingRepository,
  lease: PaymentProcessingLease,
  heartbeatMs: number
): StepRunner {
  return async (step, progress, action, getStepResult) => {
    if (progress.completedAt) return;
    if (progress.startedAt) {
      log.warn(
        `Resuming step "${step}" for payment ${lease.paymentId}; external actions of the interrupted attempt may be repeated`
      );
    }
    await processingRepository.markStepStarted({ ...lease, now: new Date(), step });

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      processingRepository.renewLease({ ...lease, now: new Date() }).catch((error: unknown) => {
        if (error instanceof PaymentProcessingClaimLostError) {
          leaseLost = true;
          clearInterval(heartbeat);
          return;
        }
        log.warn(`Lease renewal failed for payment ${lease.paymentId}`, safeStringify(error));
      });
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      await action();
    } finally {
      clearInterval(heartbeat);
    }

    try {
      await processingRepository.markStepCompleted({
        ...lease,
        now: new Date(),
        step,
        calendarResult: getStepResult?.(),
      });
    } catch (error) {
      if (error instanceof PaymentProcessingClaimLostError || leaseLost) {
        log.error(
          `Lease for payment ${lease.paymentId} was lost while step "${step}" ran; another worker may have repeated its external actions`
        );
      }
      throw error;
    }
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1000);
  return String(error).slice(0, 1000);
}

async function runClaimedConfirmation({
  paymentId,
  bookingId,
  appSlug,
  traceContext,
  state,
  lease,
  processingRepository,
  runStep,
}: HandlePaymentSuccessParams & {
  state: PaymentProcessingState;
  lease: PaymentProcessingLease;
  processingRepository: PaymentProcessingRepository;
  runStep: StepRunner;
}): Promise<void> {
  const updatedTraceContext = distributedTracing.updateTrace(traceContext, {
    bookingId,
    paymentId,
  });
  log.debug(`handling payment success for bookingId ${bookingId}, attempt ${state.attempts}`);
  const { booking, user: userWithCredentials, evt, eventType } = await getBooking(bookingId);
  const apps = eventTypeAppMetadataOptionalSchema.parse(eventType?.metadata?.apps);
  const actor = getAppActor({ appSlug, bookingId, apps });

  try {
    await tasker.cancelWithReference(booking.uid, "sendAwaitingPaymentEmail");
    log.debug(`Cancelled scheduled awaiting payment email for booking ${bookingId}`);
  } catch (error) {
    log.warn(
      { bookingId, error },
      `Failed to cancel awaiting payment task - email may still be sent but will be suppressed by task handler`
    );
  }

  if (booking.location) evt.location = booking.location;

  const allCredentials = await getAllCredentialsIncludeServiceAccountKey(userWithCredentials, {
    ...booking.eventType,
    metadata: booking.eventType?.metadata as EventTypeMetadata,
  });

  const platformOAuthClientRepository = new PlatformOAuthClientRepository();
  const platformOAuthClient = userWithCredentials.isPlatformManaged
    ? await platformOAuthClientRepository.getByUserId(userWithCredentials.id)
    : null;
  const areCalendarEventsEnabled = platformOAuthClient?.areCalendarEventsEnabled ?? true;
  const areEmailsEnabled = platformOAuthClient?.areEmailsEnabled ?? true;
  const platformClientParams = platformOAuthClient ? getPlatformParams(platformOAuthClient) : undefined;

  const requiresConfirmation = doesBookingRequireConfirmation({
    booking: {
      ...booking,
      eventType,
    },
  });

  // Decides which confirmation path runs. Recorded before the booking is updated, because after that
  // the booking is ACCEPTED and a resumed run could no longer tell the two paths apart.
  let bookingWasAcceptedBeforePayment = state.bookingWasAcceptedBeforePayment;
  if (bookingWasAcceptedBeforePayment === null) {
    bookingWasAcceptedBeforePayment = booking.status === BookingStatus.ACCEPTED;
    await processingRepository.recordBookingStatusBeforePayment({
      ...lease,
      now: new Date(),
      bookingWasAcceptedBeforePayment,
    });
  }

  if (!state.paymentRecordedAt) {
    const bookingData: Prisma.BookingUpdateInput = {
      paid: true,
      status: BookingStatus.ACCEPTED,
    };
    if (requiresConfirmation) {
      delete bookingData.status;
    }
    // Idempotent: a run that crashes before the marker below simply re-applies the same values.
    await prisma.$transaction([
      prisma.payment.update({ where: { id: paymentId }, data: { success: true }, select: { id: true } }),
      prisma.booking.update({ where: { id: booking.id }, data: bookingData, select: { id: true } }),
    ]);
    await processingRepository.markPaymentRecorded({ ...lease, now: new Date() });
  }

  const sendBookingPaid = (): Promise<void> =>
    notifyBookingPaid({
      paymentId,
      bookingId,
      booking,
      evt,
      platformClientParams,
      tracingContext: updatedTraceContext,
    });

  if (bookingWasAcceptedBeforePayment) {
    // Same order as before coordination: the calendar step enriches evt (video call data, iCalUID),
    // which BOOKING_PAID subscribers and the confirmation emails then receive. A resumed run gets that
    // enrichment from the stored step result instead of creating the meeting again.
    if (state.calendarCompletedAt) restoreCalendarStepResult(evt, state.calendarResult, paymentId);
    let calendarResult: CalendarStepResult | undefined;
    await runStep(
      "calendar",
      { startedAt: state.calendarStartedAt, completedAt: state.calendarCompletedAt },
      async () => {
        const locationBefore = evt.location;
        const eventManager = new EventManager({ ...userWithCredentials, credentials: allCredentials }, apps);
        const scheduleResult = areCalendarEventsEnabled
          ? await eventManager.create(evt)
          : placeholderCreatedEvent;
        await prisma.booking.update({
          where: { id: booking.id },
          data: { references: { create: scheduleResult.referencesToCreate } },
          select: { id: true },
        });
        calendarResult = captureCalendarStepResult(evt, locationBefore);
      },
      () => calendarResult
    );
    await runStep(
      "bookingPaid",
      { startedAt: state.bookingPaidStartedAt, completedAt: state.bookingPaidCompletedAt },
      sendBookingPaid
    );
    await runStep(
      "confirmation",
      { startedAt: state.confirmationStartedAt, completedAt: state.confirmationCompletedAt },
      async () => {
        if (areEmailsEnabled) {
          await sendScheduledEmailsAndSMS({ ...evt }, undefined, undefined, undefined, eventType.metadata);
        }
      }
    );
  } else {
    await runStep(
      "bookingPaid",
      { startedAt: state.bookingPaidStartedAt, completedAt: state.bookingPaidCompletedAt },
      sendBookingPaid
    );
    await runStep(
      "confirmation",
      { startedAt: state.confirmationStartedAt, completedAt: state.confirmationCompletedAt },
      async () => {
        if (!requiresConfirmation) {
          await handleConfirmation({
            user: { ...userWithCredentials, credentials: allCredentials },
            evt,
            prisma,
            bookingId: booking.id,
            booking,
            paid: true,
            platformClientParams,
            traceContext: updatedTraceContext,
            actionSource: "WEBHOOK",
            actor,
          });
          return;
        }
        await handleBookingRequested({
          evt,
          booking,
          oAuthClientId: platformClientParams?.platformClientId,
        });
        log.debug(`handling booking request for eventId ${eventType.id}`);
      }
    );
  }

  await processingRepository.complete({ ...lease, now: new Date() });
}

async function notifyBookingPaid({
  paymentId,
  bookingId,
  booking,
  evt,
  platformClientParams,
  tracingContext,
}: {
  paymentId: number;
  bookingId: number;
  booking: Awaited<ReturnType<typeof getBooking>>["booking"];
  evt: Awaited<ReturnType<typeof getBooking>>["evt"];
  platformClientParams: ReturnType<typeof getPlatformParams> | undefined;
  tracingContext: TraceContext;
}): Promise<void> {
  const teamId = await getTeamIdFromEventType({
    eventType: {
      team: { id: booking.eventType?.teamId ?? null },
      parentId: booking.eventType?.parentId ?? null,
    },
  });
  const triggerForUser = !teamId || (teamId && booking.eventType?.parentId);
  const userId = triggerForUser ? booking.userId : null;
  const orgId = await getOrgIdFromMemberOrTeamId({ memberId: userId, teamId });
  const bookerUrl = await getBookerBaseUrl(orgId ?? null);

  // Read back after the payment was recorded, because on a resumed run it was recorded by an earlier
  // attempt. Outside the best-effort block below so that a database error is retried, not swallowed.
  const [payment, updatedBooking] = await Promise.all([
    prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { externalId: true } }),
    prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, select: { status: true } }),
  ]);

  try {
    // Get workflows for BOOKING_PAID trigger
    const workflows = await getAllWorkflowsFromEventType(booking.eventType, booking.userId);

    const paymentExternalId = payment.externalId;

    const paymentMetadata = {
      identifier: "cal.com",
      bookingId,
      eventTypeId: booking.eventType?.id ?? null,
      bookerEmail: evt.attendees[0].email,
      eventTitle: booking.eventType?.title ?? null,
      externalId: paymentExternalId ?? null,
    };

    const eventTypeInfo: EventTypeInfo = {
      eventTitle: booking.eventType?.title,
      eventDescription: booking.eventType?.description,
      requiresConfirmation: booking.eventType?.requiresConfirmation || null,
      price: booking.eventType?.price,
      currency: booking.eventType?.currency,
      length: booking.eventType?.length,
    };

    const { assignmentReason: _emailAssignmentReason, ...evtWithoutAssignmentReason } = evt;
    const payload: EventPayloadType = {
      ...evtWithoutAssignmentReason,
      ...eventTypeInfo,
      bookingId,
      eventTypeId: booking.eventType?.id,
      status: updatedBooking.status,
      smsReminderNumber: booking.smsReminderNumber || undefined,
      paymentId: paymentId,
      metadata: paymentMetadata,
      ...(platformClientParams ? platformClientParams : {}),
    };

    // Trigger BOOKING_PAID webhooks
    const subscriberMeetingPaid = await getWebhooks({
      userId,
      eventTypeId: booking.eventTypeId,
      triggerEvent: WebhookTriggerEvents.BOOKING_PAID,
      teamId: booking.eventType?.teamId,
      orgId,
      oAuthClientId: platformClientParams?.platformClientId,
    });

    const tracingLogger = distributedTracing.getTracingLogger(tracingContext);
    const bookingPaidSubscribers = subscriberMeetingPaid.map((sub) =>
      sendPayload(
        sub.secret,
        WebhookTriggerEvents.BOOKING_PAID,
        new Date().toISOString(),
        sub,
        payload
      ).catch((e) => {
        tracingLogger.error(
          `Error executing webhook for event: ${WebhookTriggerEvents.BOOKING_PAID}, URL: ${sub.subscriberUrl}, bookingId: ${evt.bookingId}, bookingUid: ${evt.uid}`,
          safeStringify(e)
        );
      })
    );

    // Wait for webhook invocations to finish before returning
    await Promise.all(bookingPaidSubscribers);

    // Trigger BOOKING_PAID workflows
    try {
      const meetingUrl = getVideoCallUrlFromCalEvent(evt);
      const calendarEventForWorkflow = {
        ...evt,
        eventType: {
          slug: booking.eventType?.slug || "",
          schedulingType: booking.eventType?.schedulingType,
          hosts:
            booking.eventType?.hosts?.map((host) => ({
              user: {
                email: host.user.email,
                destinationCalendar: host.user.destinationCalendar,
              },
            })) || [],
        },
        bookerUrl: bookerUrl,
        metadata: meetingUrl ? { videoCallUrl: meetingUrl } : undefined,
      };

      const creditService = new CreditService();

      await WorkflowService.scheduleWorkflowsFilteredByTriggerEvent({
        workflows,
        smsReminderNumber: booking.smsReminderNumber,
        calendarEvent: calendarEventForWorkflow,
        hideBranding: evt.hideBranding ?? false,
        triggers: [WorkflowTriggerEvents.BOOKING_PAID],
        creditCheckFn: creditService.hasAvailableCredits.bind(creditService),
      });
    } catch (error) {
      log.error("Error while scheduling workflow reminders for booking paid", safeStringify(error));
    }
  } catch (error) {
    log.error("Error while triggering BOOKING_PAID webhook", safeStringify(error));
  }
}

/**
 * Confirms a paid booking at most once per payment, even if the payment provider delivers the
 * success event repeatedly, concurrently or as different event types.
 *
 * A database lease (PaymentProcessing) ensures a single worker; progress markers let a later delivery
 * resume after a crash or error instead of repeating finished steps or giving up.
 * Throws HttpCode 200 when the payment is confirmed (now or earlier), 409 while another worker holds
 * the lease (the provider should retry), and rethrows unexpected errors (provider should retry).
 */
export async function handlePaymentSuccess(
  params: HandlePaymentSuccessParams,
  timing: PaymentProcessingTiming = {
    leaseMs: PAYMENT_PROCESSING_LEASE_MS,
    heartbeatMs: PAYMENT_PROCESSING_HEARTBEAT_MS,
  }
): Promise<never> {
  const { paymentId, bookingId } = params;
  const processingRepository = new PaymentProcessingRepository(prisma);
  const lease: PaymentProcessingLease = {
    paymentId,
    claimToken: randomUUID(),
    leaseMs: timing.leaseMs,
  };

  const claim = await processingRepository.claim({ ...lease, now: new Date() });
  if (claim.outcome === "completed") {
    throw new HttpCode({ statusCode: 200, message: `Payment ${paymentId} was already confirmed` });
  }
  if (claim.outcome === "busy") {
    throw new HttpCode({
      statusCode: 409,
      message: `Confirmation of payment ${paymentId} is already in progress`,
    });
  }

  try {
    await runClaimedConfirmation({
      ...params,
      state: claim.state,
      lease,
      processingRepository,
      runStep: createStepRunner(processingRepository, lease, timing.heartbeatMs),
    });
  } catch (error) {
    await processingRepository
      .fail({ ...lease, now: new Date(), error: describeError(error) })
      .catch((releaseError) => {
        log.error(`Failed to release processing claim for payment ${paymentId}`, safeStringify(releaseError));
      });
    throw error;
  }

  throw new HttpCode({
    statusCode: 200,
    message: `Booking with id '${bookingId}' was paid and confirmed.`,
  });
}
