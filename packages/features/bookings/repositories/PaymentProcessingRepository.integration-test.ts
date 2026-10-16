import { randomUUID } from "node:crypto";
import process from "node:process";
import { PrismaClient } from "@calcom/prisma/client";
import { PaymentProcessingStatus } from "@calcom/prisma/enums";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PaymentProcessingClaimLostError, PaymentProcessingRepository } from "./PaymentProcessingRepository";

// These tests exercise PostgreSQL locking and ON CONFLICT semantics, so they need a real database.
// Guarded to a throwaway local instance to make it impossible to run them against shared data.
const databaseUrl = process.env.PAYMENT_PROCESSING_TEST_DATABASE_URL ?? "";
const isIsolatedTestDatabase = /@(127\.0\.0\.1|localhost):\d+\/calcom_s2_test$/.test(databaseUrl);

const LEASE_MS = 10 * 60 * 1000;

describe.skipIf(!isIsolatedTestDatabase)("PaymentProcessingRepository (PostgreSQL)", () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const repository = new PaymentProcessingRepository(prisma);
  const createdBookingIds: number[] = [];
  const extraClients: PrismaClient[] = [];

  async function createPayment({ success = false }: { success?: boolean } = {}): Promise<number> {
    const booking = await prisma.booking.create({
      data: {
        uid: `s2-test-${randomUUID()}`,
        title: "Synthetic booking",
        startTime: new Date("2030-01-01T10:00:00Z"),
        endTime: new Date("2030-01-01T11:00:00Z"),
      },
      select: { id: true },
    });
    createdBookingIds.push(booking.id);
    const payment = await prisma.payment.create({
      data: {
        uid: randomUUID(),
        bookingId: booking.id,
        amount: 10000,
        fee: 0,
        currency: "eur",
        success,
        refunded: false,
        data: {},
        externalId: `cs_test_${randomUUID()}`,
      },
      select: { id: true },
    });
    return payment.id;
  }

  function lease(paymentId: number, claimToken = randomUUID()) {
    return { paymentId, claimToken, leaseMs: LEASE_MS };
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  beforeEach(() => {
    createdBookingIds.length = 0;
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { uid: { startsWith: "s2-test-" } } });
    await Promise.all(extraClients.map((client) => client.$disconnect()));
    await prisma.$disconnect();
  });

  function separateClient(): PrismaClient {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    extraClients.push(client);
    return client;
  }

  it("lets exactly one of many concurrent claims from separate connection pools win", async () => {
    const paymentId = await createPayment();
    const now = new Date();
    const repositories = Array.from({ length: 5 }, () => new PaymentProcessingRepository(separateClient()));

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        repositories[i % repositories.length].claim({ ...lease(paymentId), now })
      )
    );

    expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "busy")).toHaveLength(24);
    const row = await prisma.paymentProcessing.findUniqueOrThrow({ where: { paymentId } });
    expect(row.status).toBe(PaymentProcessingStatus.PROCESSING);
    expect(row.attempts).toBe(1);
  });

  it.each([
    ["commits", "busy"],
    ["rolls back", "claimed"],
  ] as const)("a competing claim blocks on the uncommitted claim and, when the holder %s, becomes %s", async (holderOutcome, expected) => {
    const paymentId = await createPayment();
    const now = new Date();
    const competitor = new PaymentProcessingRepository(separateClient());
    let competingClaim: ReturnType<PaymentProcessingRepository["claim"]> | undefined;
    let settledWhileHolderOpen = false;

    await prisma
      .$transaction(async (tx) => {
        // Test-only: run the repository inside an interactive transaction to keep its row lock open.
        const holder = new PaymentProcessingRepository(tx as unknown as PrismaClient);
        expect((await holder.claim({ ...lease(paymentId), now })).outcome).toBe("claimed");

        competingClaim = competitor.claim({ ...lease(paymentId), now });
        competingClaim.then(
          () => {
            settledWhileHolderOpen = true;
          },
          () => {
            settledWhileHolderOpen = true;
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settledWhileHolderOpen).toBe(false);

        if (holderOutcome === "rolls back") throw new Error("rollback holder");
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.message === "rollback holder")) throw error;
      });

    expect((await competingClaim)?.outcome).toBe(expected);
  });

  it("keeps an active lease exclusive and lets another worker take over after expiry", async () => {
    const paymentId = await createPayment();
    const t0 = new Date("2030-01-01T09:00:00Z");
    const first = lease(paymentId);
    expect((await repository.claim({ ...first, now: t0 })).outcome).toBe("claimed");

    const beforeExpiry = new Date(t0.getTime() + LEASE_MS - 1000);
    expect((await repository.claim({ ...lease(paymentId), now: beforeExpiry })).outcome).toBe("busy");

    const afterExpiry = new Date(t0.getTime() + LEASE_MS + 1000);
    const second = lease(paymentId);
    const takeover = await repository.claim({ ...second, now: afterExpiry });
    expect(takeover.outcome).toBe("claimed");
    if (takeover.outcome === "claimed") expect(takeover.state.attempts).toBe(2);

    // The crashed/hung first worker is fenced off and cannot advance the state any more.
    await expect(repository.markPaymentRecorded({ ...first, now: afterExpiry })).rejects.toBeInstanceOf(
      PaymentProcessingClaimLostError
    );
    await expect(repository.complete({ ...first, now: afterExpiry })).rejects.toBeInstanceOf(
      PaymentProcessingClaimLostError
    );
    await repository.markPaymentRecorded({ ...second, now: afterExpiry });
  });

  it("concurrent takeovers of an expired lease still produce a single winner", async () => {
    const paymentId = await createPayment();
    const t0 = new Date("2030-01-01T09:00:00Z");
    await repository.claim({ ...lease(paymentId), now: t0 });
    const afterExpiry = new Date(t0.getTime() + LEASE_MS + 1000);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => repository.claim({ ...lease(paymentId), now: afterExpiry }))
    );

    expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
  });

  it("renews the lease on every step so a long but healthy run is not taken over", async () => {
    const paymentId = await createPayment();
    const t0 = new Date("2030-01-01T09:00:00Z");
    const worker = lease(paymentId);
    await repository.claim({ ...worker, now: t0 });

    const later = new Date(t0.getTime() + LEASE_MS - 1000);
    await repository.markStepStarted({ ...worker, now: later, step: "confirmation" });

    const pastOriginalLease = new Date(t0.getTime() + LEASE_MS + 1000);
    expect((await repository.claim({ ...lease(paymentId), now: pastOriginalLease })).outcome).toBe("busy");
  });

  it("returns the recorded progress to the worker that resumes after a failure", async () => {
    const paymentId = await createPayment();
    const now = new Date();
    const first = lease(paymentId);
    await repository.claim({ ...first, now });
    await repository.recordBookingStatusBeforePayment({
      ...first,
      now,
      bookingWasAcceptedBeforePayment: false,
    });
    await repository.markPaymentRecorded({ ...first, now });
    await repository.markStepStarted({ ...first, now, step: "bookingPaid" });
    await repository.markStepCompleted({ ...first, now, step: "bookingPaid" });
    await repository.markStepStarted({ ...first, now, step: "confirmation" });
    await prisma.payment.update({ where: { id: paymentId }, data: { success: true } });
    await repository.fail({ ...first, now, error: "SMTP timeout" });

    const resumed = await repository.claim({ ...lease(paymentId), now });

    expect(resumed.outcome).toBe("claimed");
    if (resumed.outcome !== "claimed") return;
    expect(resumed.state).toMatchObject({
      attempts: 2,
      bookingWasAcceptedBeforePayment: false,
      bookingPaidCompletedAt: expect.any(Date),
      confirmationStartedAt: expect.any(Date),
      confirmationCompletedAt: null,
    });
    expect(resumed.state.paymentRecordedAt).toBeInstanceOf(Date);
    const row = await prisma.paymentProcessing.findUniqueOrThrow({ where: { paymentId } });
    expect(row.lastError).toBe("SMTP timeout");
  });

  it("treats a completed run as final", async () => {
    const paymentId = await createPayment();
    const now = new Date();
    const worker = lease(paymentId);
    await repository.claim({ ...worker, now });
    await repository.complete({ ...worker, now });

    expect((await repository.claim({ ...lease(paymentId), now })).outcome).toBe("completed");
    const row = await prisma.paymentProcessing.findUniqueOrThrow({ where: { paymentId } });
    expect(row).toMatchObject({
      status: PaymentProcessingStatus.COMPLETED,
      claimToken: null,
      leaseExpiresAt: null,
    });
  });

  it("does not re-run payments that were already successful before coordination existed", async () => {
    const paymentId = await createPayment({ success: true });

    expect((await repository.claim({ ...lease(paymentId), now: new Date() })).outcome).toBe("completed");
    expect(await prisma.paymentProcessing.findUnique({ where: { paymentId } })).toBeNull();
  });

  it("rejects claims for unknown payments", async () => {
    await expect(repository.claim({ ...lease(2_000_000_000), now: new Date() })).rejects.toThrow(
      /does not exist/
    );
  });
});
