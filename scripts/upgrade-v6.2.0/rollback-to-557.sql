-- Rolls a database migrated by the Cal.com v6.2.0 upgrade (589 migrations) back to the schema of the
-- production revision d491be09d799c65971a815b6543460910ba2f031 (557 migrations: v6.1.0 base + S2), so that the
-- previous image (ghcr.io/oleg-rom/cal.com-fork@sha256:a04fcb22...) can run on it again.
--
-- Run with the NEW image stopped, in one transaction, after a fresh pg_dump:
--   psql -v ON_ERROR_STOP=1 -f rollback-to-557.sql
--
-- Lossy by design (data that only exists in v6.2.0):
-- - rows and columns of objects added by the 32 migrations are dropped (HostLocation, RoutingTrace,
--   PendingRoutingTrace, WorkflowStepTranslation, WrongAssignmentReport, Credential.encryptedKey, ...);
-- - BookingAudit.action 'no_show_updated' becomes 'host_no_show_updated' (v6.2.0 merged the two old values);
--   BookingAudit.source 'system' becomes 'unknown'; Watchlist.source 'SIGNUP' becomes 'MANUAL';
-- - webhook triggers ROUTING_FORM_FALLBACK_HIT and WRONG_ASSIGNMENT_REPORT are removed from subscriptions;
-- - users.startTime/endTime come back with their defaults (0/1440); values dropped by the upgrade are not
--   restored (production had only the defaults on 2026-10-17).
-- Feature flags pbac and onboarding-v3 are set back to their pre-upgrade values. On production both were
-- false (checked 2026-10-17); re-check before the upgrade and adjust the two UPDATEs if they differ.

BEGIN;

-- 0. Guard: exactly the 32 v6.2.0 migrations must be applied, and nothing newer than them.
DO $$
DECLARE applied int;
BEGIN
  SELECT count(*) INTO applied FROM _prisma_migrations
  WHERE migration_name IN (
  '20260114154054_add_oauth_client_properties',
  '20260115111819_add_cancellation_reason_require',
  '20260116145525_add_custom_host_location',
  '20260119113000_add_system_source',
  '20260119120000_add_seat_change_log_operation_id',
  '20260119184420_add_calendar_subscription_error',
  '20260120093500_add_no_show_updated_audit_action',
  '20260121145242_add_workflow_step_translation',
  '20260121191700_add_eventtype_parentid_teamid_index',
  '20260122133147_add_wrong_assignment_webhook',
  '20260122140703_add_credential_teamid_index',
  '20260122145500_drop_user_starttime_endtime',
  '20260122165837_add_encrypted_key_to_credential',
  '20260126173100_add_form_response_formid_createdat_index',
  '20260127035022_add_routing_trace_tables',
  '20260127140951_add_invoice_url_to_proration',
  '20260128004200_add_booking_composite_indexes',
  '20260128170309_add_secondary_email_index',
  '20260129090913_enable_pbac_globally',
  '20260129170000_pbac_add_password_reset_permission',
  '20260129205827_add_wrong_assignment_report_table',
  '20260130000000_add_selected_calendar_channel_id_index',
  '20260130043627_add_reviewed_fields_to_wrong_assignment_report',
  '20260130100000_add_high_water_mark_fields',
  '20260201053520_add_redirect_url_on_no_routing_form_response',
  '20260210000000_add_billing_mode',
  '20260210142544_add_audit_logs_permissions_to_admin_role',
  '20260211234000_add_composite_index_wrong_assignment_report',
  '20260212202500_add_signup_watchlist_review_feature',
  '20260213000000_enable_onboarding_v3_globally',
  '20260218000000_add_routing_form_fallback_hit_webhook_trigger',
  '20260219000000_add_fallback_action_to_queued_form_response'
  ) AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF applied <> 32 THEN
    RAISE EXCEPTION 'expected the 32 v6.2.0 migrations to be applied, found %', applied;
  END IF;
  IF (SELECT count(*) FROM _prisma_migrations) <> 589 THEN
    RAISE EXCEPTION 'expected 589 migrations, found %', (SELECT count(*) FROM _prisma_migrations);
  END IF;
END $$;

-- 1. Webhook subscriptions to triggers that do not exist before v6.2.0
UPDATE "Webhook"
SET "eventTriggers" = array_remove(array_remove("eventTriggers", 'ROUTING_FORM_FALLBACK_HIT'), 'WRONG_ASSIGNMENT_REPORT')
WHERE 'ROUTING_FORM_FALLBACK_HIT' = ANY ("eventTriggers") OR 'WRONG_ASSIGNMENT_REPORT' = ANY ("eventTriggers");

-- 2. Schema: generated with `prisma migrate diff --from-url <589 database> --to-schema-datamodel
--    <schema.prisma of d491be09> --script`; enum casts map the values that only exist in v6.2.0.
-- AlterEnum
CREATE TYPE "public"."BookingAuditAction_new" AS ENUM ('created', 'cancelled', 'accepted', 'rejected', 'pending', 'awaiting_host', 'rescheduled', 'attendee_added', 'attendee_removed', 'reassignment', 'location_changed', 'host_no_show_updated', 'attendee_no_show_updated', 'reschedule_requested', 'seat_booked', 'seat_rescheduled');
ALTER TABLE "public"."BookingAudit" ALTER COLUMN "action" TYPE "public"."BookingAuditAction_new" USING ((CASE WHEN "action"::text = 'no_show_updated' THEN 'host_no_show_updated' ELSE "action"::text END)::"public"."BookingAuditAction_new");
ALTER TYPE "public"."BookingAuditAction" RENAME TO "BookingAuditAction_old";
ALTER TYPE "public"."BookingAuditAction_new" RENAME TO "BookingAuditAction";
DROP TYPE "public"."BookingAuditAction_old";

-- AlterEnum
CREATE TYPE "public"."BookingAuditSource_new" AS ENUM ('api_v1', 'api_v2', 'webapp', 'webhook', 'unknown', 'magic_link');
ALTER TABLE "public"."BookingAudit" ALTER COLUMN "source" TYPE "public"."BookingAuditSource_new" USING ((CASE WHEN "source"::text = 'system' THEN 'unknown' ELSE "source"::text END)::"public"."BookingAuditSource_new");
ALTER TYPE "public"."BookingAuditSource" RENAME TO "BookingAuditSource_old";
ALTER TYPE "public"."BookingAuditSource_new" RENAME TO "BookingAuditSource";
DROP TYPE "public"."BookingAuditSource_old";

-- AlterEnum
CREATE TYPE "public"."WatchlistSource_new" AS ENUM ('MANUAL', 'FREE_DOMAIN_POLICY');
ALTER TABLE "public"."Watchlist" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "public"."Watchlist" ALTER COLUMN "source" TYPE "public"."WatchlistSource_new" USING ((CASE WHEN "source"::text = 'SIGNUP' THEN 'MANUAL' ELSE "source"::text END)::"public"."WatchlistSource_new");
ALTER TYPE "public"."WatchlistSource" RENAME TO "WatchlistSource_old";
ALTER TYPE "public"."WatchlistSource_new" RENAME TO "WatchlistSource";
DROP TYPE "public"."WatchlistSource_old";
ALTER TABLE "public"."Watchlist" ALTER COLUMN "source" SET DEFAULT 'MANUAL';

-- AlterEnum
CREATE TYPE "public"."WebhookTriggerEvents_new" AS ENUM ('BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED', 'FORM_SUBMITTED', 'MEETING_ENDED', 'RECORDING_READY', 'BOOKING_PAID', 'BOOKING_REQUESTED', 'BOOKING_REJECTED', 'BOOKING_PAYMENT_INITIATED', 'MEETING_STARTED', 'INSTANT_MEETING', 'OOO_CREATED', 'BOOKING_NO_SHOW_UPDATED', 'RECORDING_TRANSCRIPTION_GENERATED', 'AFTER_HOSTS_CAL_VIDEO_NO_SHOW', 'AFTER_GUESTS_CAL_VIDEO_NO_SHOW', 'FORM_SUBMITTED_NO_EVENT', 'DELEGATION_CREDENTIAL_ERROR');
ALTER TABLE "public"."Webhook" ALTER COLUMN "eventTriggers" TYPE "public"."WebhookTriggerEvents_new"[] USING ("eventTriggers"::text::"public"."WebhookTriggerEvents_new"[]);
ALTER TYPE "public"."WebhookTriggerEvents" RENAME TO "WebhookTriggerEvents_old";
ALTER TYPE "public"."WebhookTriggerEvents_new" RENAME TO "WebhookTriggerEvents";
DROP TYPE "public"."WebhookTriggerEvents_old";

-- DropForeignKey
ALTER TABLE "public"."HostLocation" DROP CONSTRAINT "HostLocation_credentialId_fkey";

-- DropForeignKey
ALTER TABLE "public"."HostLocation" DROP CONSTRAINT "HostLocation_userId_eventTypeId_fkey";

-- DropForeignKey
ALTER TABLE "public"."OAuthClient" DROP CONSTRAINT "OAuthClient_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."PendingRoutingTrace" DROP CONSTRAINT "PendingRoutingTrace_formResponseId_fkey";

-- DropForeignKey
ALTER TABLE "public"."PendingRoutingTrace" DROP CONSTRAINT "PendingRoutingTrace_queuedFormResponseId_fkey";

-- DropForeignKey
ALTER TABLE "public"."RoutingTrace" DROP CONSTRAINT "RoutingTrace_assignmentReasonId_fkey";

-- DropForeignKey
ALTER TABLE "public"."RoutingTrace" DROP CONSTRAINT "RoutingTrace_bookingUid_fkey";

-- DropForeignKey
ALTER TABLE "public"."RoutingTrace" DROP CONSTRAINT "RoutingTrace_formResponseId_fkey";

-- DropForeignKey
ALTER TABLE "public"."RoutingTrace" DROP CONSTRAINT "RoutingTrace_queuedFormResponseId_fkey";

-- DropForeignKey
ALTER TABLE "public"."WorkflowStepTranslation" DROP CONSTRAINT "WorkflowStepTranslation_workflowStepId_fkey";

-- DropForeignKey
ALTER TABLE "public"."WrongAssignmentReport" DROP CONSTRAINT "WrongAssignmentReport_bookingUid_fkey";

-- DropForeignKey
ALTER TABLE "public"."WrongAssignmentReport" DROP CONSTRAINT "WrongAssignmentReport_reportedById_fkey";

-- DropForeignKey
ALTER TABLE "public"."WrongAssignmentReport" DROP CONSTRAINT "WrongAssignmentReport_reviewedById_fkey";

-- DropForeignKey
ALTER TABLE "public"."WrongAssignmentReport" DROP CONSTRAINT "WrongAssignmentReport_routingFormId_fkey";

-- DropForeignKey
ALTER TABLE "public"."WrongAssignmentReport" DROP CONSTRAINT "WrongAssignmentReport_teamId_fkey";

-- DropIndex
DROP INDEX "public"."App_RoutingForms_FormResponse_formId_createdAt_idx";

-- DropIndex
DROP INDEX "public"."Attendee_email_bookingId_idx";

-- DropIndex
DROP INDEX "public"."Booking_eventTypeId_status_idx";

-- DropIndex
DROP INDEX "public"."Booking_userId_createdAt_idx";

-- DropIndex
DROP INDEX "public"."Booking_userId_endTime_idx";

-- DropIndex
DROP INDEX "public"."Booking_userId_status_startTime_idx";

-- DropIndex
DROP INDEX "public"."Credential_teamId_idx";

-- DropIndex
DROP INDEX "public"."EventType_parentId_teamId_idx";

-- DropIndex
DROP INDEX "public"."OAuthClient_userId_idx";

-- DropIndex
DROP INDEX "public"."SeatChangeLog_teamId_operationId_key";

-- DropIndex
DROP INDEX "public"."SecondaryEmail_email_emailVerified_idx";

-- DropIndex
DROP INDEX "public"."SelectedCalendar_channelId_idx";

-- AlterTable
ALTER TABLE "public"."App_RoutingForms_QueuedFormResponse" DROP COLUMN "fallbackAction";

-- AlterTable
ALTER TABLE "public"."Credential" DROP COLUMN "encryptedKey";

-- AlterTable
ALTER TABLE "public"."EventType" DROP COLUMN "enablePerHostLocations",
DROP COLUMN "redirectUrlOnNoRoutingFormResponse",
DROP COLUMN "requiresCancellationReason";

-- AlterTable
ALTER TABLE "public"."MonthlyProration" DROP COLUMN "invoiceUrl";

-- AlterTable
ALTER TABLE "public"."OAuthClient" DROP COLUMN "createdAt",
DROP COLUMN "purpose",
DROP COLUMN "rejectionReason",
DROP COLUMN "status",
DROP COLUMN "userId",
DROP COLUMN "websiteUrl";

-- AlterTable
ALTER TABLE "public"."OrganizationBilling" DROP COLUMN "billingMode",
DROP COLUMN "highWaterMark",
DROP COLUMN "highWaterMarkPeriodStart";

-- AlterTable
ALTER TABLE "public"."SeatChangeLog" DROP COLUMN "operationId";

-- AlterTable
ALTER TABLE "public"."SelectedCalendar" DROP COLUMN "syncSubscribedErrorAt",
DROP COLUMN "syncSubscribedErrorCount";

-- AlterTable
ALTER TABLE "public"."TeamBilling" DROP COLUMN "billingMode",
DROP COLUMN "highWaterMark",
DROP COLUMN "highWaterMarkPeriodStart";

-- AlterTable
ALTER TABLE "public"."WorkflowStep" DROP COLUMN "autoTranslateEnabled",
DROP COLUMN "sourceLocale";

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "endTime" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN     "startTime" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "public"."HostLocation";

-- DropTable
DROP TABLE "public"."PendingRoutingTrace";

-- DropTable
DROP TABLE "public"."RoutingTrace";

-- DropTable
DROP TABLE "public"."WorkflowStepTranslation";

-- DropTable
DROP TABLE "public"."WrongAssignmentReport";

-- DropEnum
DROP TYPE "public"."BillingMode";

-- DropEnum
DROP TYPE "public"."CancellationReasonRequirement";

-- DropEnum
DROP TYPE "public"."OAuthClientStatus";

-- DropEnum
DROP TYPE "public"."WorkflowStepAutoTranslatedField";

-- DropEnum
DROP TYPE "public"."WrongAssignmentReportStatus";


-- 3. Data written by the v6.2.0 migrations
UPDATE "Feature" SET "enabled" = false WHERE "slug" = 'pbac';           -- 20260129090913_enable_pbac_globally
UPDATE "Feature" SET "enabled" = false WHERE "slug" = 'onboarding-v3';  -- 20260213000000_enable_onboarding_v3_globally
DELETE FROM "Feature" WHERE "slug" IN ('active-user-billing', 'hwm-seating', 'signup-watchlist-review');
DELETE FROM "RolePermission"
WHERE "roleId" = 'admin_role'
  AND (resource, action) IN (('booking', 'readOrgAuditLogs'), ('booking', 'readTeamAuditLogs'), ('organization', 'passwordReset'));

-- 4. Migration history, so that a later upgrade applies the 32 migrations again
DELETE FROM _prisma_migrations WHERE migration_name IN (
  '20260114154054_add_oauth_client_properties',
  '20260115111819_add_cancellation_reason_require',
  '20260116145525_add_custom_host_location',
  '20260119113000_add_system_source',
  '20260119120000_add_seat_change_log_operation_id',
  '20260119184420_add_calendar_subscription_error',
  '20260120093500_add_no_show_updated_audit_action',
  '20260121145242_add_workflow_step_translation',
  '20260121191700_add_eventtype_parentid_teamid_index',
  '20260122133147_add_wrong_assignment_webhook',
  '20260122140703_add_credential_teamid_index',
  '20260122145500_drop_user_starttime_endtime',
  '20260122165837_add_encrypted_key_to_credential',
  '20260126173100_add_form_response_formid_createdat_index',
  '20260127035022_add_routing_trace_tables',
  '20260127140951_add_invoice_url_to_proration',
  '20260128004200_add_booking_composite_indexes',
  '20260128170309_add_secondary_email_index',
  '20260129090913_enable_pbac_globally',
  '20260129170000_pbac_add_password_reset_permission',
  '20260129205827_add_wrong_assignment_report_table',
  '20260130000000_add_selected_calendar_channel_id_index',
  '20260130043627_add_reviewed_fields_to_wrong_assignment_report',
  '20260130100000_add_high_water_mark_fields',
  '20260201053520_add_redirect_url_on_no_routing_form_response',
  '20260210000000_add_billing_mode',
  '20260210142544_add_audit_logs_permissions_to_admin_role',
  '20260211234000_add_composite_index_wrong_assignment_report',
  '20260212202500_add_signup_watchlist_review_feature',
  '20260213000000_enable_onboarding_v3_globally',
  '20260218000000_add_routing_form_fallback_hit_webhook_trigger',
  '20260219000000_add_fallback_action_to_queued_form_response'
);

COMMIT;
