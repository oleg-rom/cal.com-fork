-- CreateEnum
CREATE TYPE "public"."PaymentProcessingStatus" AS ENUM ('PROCESSING', 'FAILED', 'COMPLETED');

-- CreateTable
CREATE TABLE "public"."PaymentProcessing" (
    "paymentId" INTEGER NOT NULL,
    "status" "public"."PaymentProcessingStatus" NOT NULL,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "bookingWasAcceptedBeforePayment" BOOLEAN,
    "paymentRecordedAt" TIMESTAMP(3),
    "calendarStartedAt" TIMESTAMP(3),
    "calendarCompletedAt" TIMESTAMP(3),
    "calendarStartCount" INTEGER NOT NULL DEFAULT 0,
    "calendarResult" JSONB,
    "bookingPaidStartedAt" TIMESTAMP(3),
    "bookingPaidCompletedAt" TIMESTAMP(3),
    "bookingPaidStartCount" INTEGER NOT NULL DEFAULT 0,
    "confirmationStartedAt" TIMESTAMP(3),
    "confirmationCompletedAt" TIMESTAMP(3),
    "confirmationStartCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProcessing_pkey" PRIMARY KEY ("paymentId")
);

-- CreateIndex
CREATE INDEX "PaymentProcessing_status_leaseExpiresAt_idx" ON "public"."PaymentProcessing"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "public"."PaymentProcessing" ADD CONSTRAINT "PaymentProcessing_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

