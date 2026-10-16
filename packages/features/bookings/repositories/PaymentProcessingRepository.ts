import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { PaymentProcessingStatus } from "@calcom/prisma/enums";

const processingStateSelect = {
  paymentId: true,
  status: true,
  attempts: true,
  bookingWasAcceptedBeforePayment: true,
  paymentRecordedAt: true,
  calendarStartedAt: true,
  calendarCompletedAt: true,
  calendarResult: true,
  bookingPaidStartedAt: true,
  bookingPaidCompletedAt: true,
  confirmationStartedAt: true,
  confirmationCompletedAt: true,
} satisfies Prisma.PaymentProcessingSelect;

// Columns are TIMESTAMP(3) without time zone holding UTC; epoch milliseconds keep the
// comparison independent of the database session time zone and of the driver's Date encoding.
function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(to_timestamp(${date.getTime()}::double precision / 1000) AT TIME ZONE 'UTC')`;
}

export type PaymentProcessingState = Prisma.PaymentProcessingGetPayload<{
  select: typeof processingStateSelect;
}>;

export type PaymentProcessingClaim =
  | { outcome: "claimed"; state: PaymentProcessingState }
  | { outcome: "completed" }
  | { outcome: "busy" };

export type PaymentProcessingStep = "calendar" | "bookingPaid" | "confirmation";

export type PaymentProcessingLease = {
  paymentId: number;
  claimToken: string;
  leaseMs: number;
};

export class PaymentProcessingClaimLostError extends Error {
  constructor(paymentId: number) {
    super(`Lost the processing claim for payment ${paymentId}`);
    this.name = "PaymentProcessingClaimLostError";
  }
}

export class PaymentProcessingRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  /**
   * Atomically takes the processing lease for a payment. Succeeds for a new payment, a FAILED run,
   * or a PROCESSING run whose lease has expired (the previous worker crashed or hung).
   */
  async claim({
    paymentId,
    claimToken,
    leaseMs,
    now,
  }: PaymentProcessingLease & { now: Date }): Promise<PaymentProcessingClaim> {
    const nowSql = utcTimestamp(now);
    const leaseExpiresAtSql = utcTimestamp(new Date(now.getTime() + leaseMs));

    // Payments that were already successful before this table existed have no row and must not be
    // re-confirmed, so a fresh row is only inserted for payments that are not yet successful.
    const claimed = await this.prismaClient.$queryRaw<{ paymentId: number }[]>(Prisma.sql`
      INSERT INTO "PaymentProcessing" ("paymentId", "status", "claimToken", "leaseExpiresAt", "attempts", "createdAt", "updatedAt")
      SELECT p."id", 'PROCESSING'::"PaymentProcessingStatus", ${claimToken}, ${leaseExpiresAtSql}, 1, ${nowSql}, ${nowSql}
      FROM "Payment" p
      WHERE p."id" = ${paymentId}
        AND (p."success" = false OR EXISTS (SELECT 1 FROM "PaymentProcessing" pp WHERE pp."paymentId" = p."id"))
      ON CONFLICT ("paymentId") DO UPDATE SET
        "status" = 'PROCESSING'::"PaymentProcessingStatus",
        "claimToken" = EXCLUDED."claimToken",
        "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
        "attempts" = "PaymentProcessing"."attempts" + 1,
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE "PaymentProcessing"."status" = 'FAILED'::"PaymentProcessingStatus"
        OR (
          "PaymentProcessing"."status" = 'PROCESSING'::"PaymentProcessingStatus"
          AND ("PaymentProcessing"."leaseExpiresAt" IS NULL OR "PaymentProcessing"."leaseExpiresAt" <= ${nowSql})
        )
      RETURNING "paymentId"
    `);

    if (claimed.length === 1) {
      const state = await this.prismaClient.paymentProcessing.findUniqueOrThrow({
        where: { paymentId },
        select: processingStateSelect,
      });
      return { outcome: "claimed", state };
    }

    const existing = await this.prismaClient.paymentProcessing.findUnique({
      where: { paymentId },
      select: { status: true },
    });
    if (existing?.status === PaymentProcessingStatus.COMPLETED) return { outcome: "completed" };
    if (existing) return { outcome: "busy" };

    const payment = await this.prismaClient.payment.findUnique({
      where: { id: paymentId },
      select: { success: true },
    });
    if (!payment) {
      throw new Error(`Unable to claim payment processing: payment ${paymentId} does not exist`);
    }
    if (payment.success) return { outcome: "completed" };
    return { outcome: "busy" };
  }

  async recordBookingStatusBeforePayment(
    lease: PaymentProcessingLease & { now: Date; bookingWasAcceptedBeforePayment: boolean }
  ): Promise<void> {
    await this.updateWithLease(lease, {
      bookingWasAcceptedBeforePayment: lease.bookingWasAcceptedBeforePayment,
    });
  }

  async markPaymentRecorded(lease: PaymentProcessingLease & { now: Date }): Promise<void> {
    await this.updateWithLease(lease, { paymentRecordedAt: lease.now });
  }

  async markStepStarted(
    lease: PaymentProcessingLease & { now: Date; step: PaymentProcessingStep }
  ): Promise<void> {
    if (lease.step === "calendar") {
      await this.updateWithLease(lease, {
        calendarStartedAt: lease.now,
        calendarStartCount: { increment: 1 },
      });
      return;
    }
    if (lease.step === "bookingPaid") {
      await this.updateWithLease(lease, {
        bookingPaidStartedAt: lease.now,
        bookingPaidStartCount: { increment: 1 },
      });
      return;
    }
    await this.updateWithLease(lease, {
      confirmationStartedAt: lease.now,
      confirmationStartCount: { increment: 1 },
    });
  }

  /** For the calendar step, its result is stored in the same fenced write as the completion marker. */
  async markStepCompleted(
    lease: PaymentProcessingLease & {
      now: Date;
      step: PaymentProcessingStep;
      calendarResult?: Prisma.InputJsonValue;
    }
  ): Promise<void> {
    if (lease.step === "calendar") {
      await this.updateWithLease(lease, {
        calendarCompletedAt: lease.now,
        calendarResult: lease.calendarResult ?? Prisma.DbNull,
      });
      return;
    }
    if (lease.step === "bookingPaid") {
      await this.updateWithLease(lease, { bookingPaidCompletedAt: lease.now });
      return;
    }
    await this.updateWithLease(lease, { confirmationCompletedAt: lease.now });
  }

  /** Heartbeat: extends the lease while a long external call is running. */
  async renewLease(lease: PaymentProcessingLease & { now: Date }): Promise<void> {
    await this.updateWithLease(lease, {});
  }

  async complete(lease: PaymentProcessingLease & { now: Date }): Promise<void> {
    await this.updateWithLease(lease, {
      status: PaymentProcessingStatus.COMPLETED,
      completedAt: lease.now,
      claimToken: null,
      leaseExpiresAt: null,
      lastError: null,
    });
  }

  /** Releases the lease immediately so that the next delivery can resume without waiting for expiry. */
  async fail(lease: PaymentProcessingLease & { now: Date; error: string }): Promise<void> {
    await this.prismaClient.paymentProcessing.updateMany({
      where: {
        paymentId: lease.paymentId,
        claimToken: lease.claimToken,
        status: PaymentProcessingStatus.PROCESSING,
      },
      data: {
        status: PaymentProcessingStatus.FAILED,
        claimToken: null,
        leaseExpiresAt: null,
        lastError: lease.error,
      },
    });
  }

  /**
   * Every write is fenced by the claim token, so a worker whose lease was taken over cannot keep
   * advancing the state. Each successful write also renews the lease.
   */
  private async updateWithLease(
    lease: PaymentProcessingLease & { now: Date },
    data: Prisma.PaymentProcessingUpdateManyMutationInput
  ): Promise<void> {
    const { count } = await this.prismaClient.paymentProcessing.updateMany({
      where: {
        paymentId: lease.paymentId,
        claimToken: lease.claimToken,
        status: PaymentProcessingStatus.PROCESSING,
      },
      data: {
        leaseExpiresAt: new Date(lease.now.getTime() + lease.leaseMs),
        ...data,
      },
    });
    if (count !== 1) throw new PaymentProcessingClaimLostError(lease.paymentId);
  }
}
