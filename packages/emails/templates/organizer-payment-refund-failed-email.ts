import { EMAIL_FROM_NAME } from "@calcom/lib/constants";

import renderEmail from "../src/renderEmail";
import OrganizerScheduledEmail from "./organizer-scheduled-email";

export default class OrganizerPaymentRefundFailedEmail extends OrganizerScheduledEmail {
  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    const toAddresses = [this.teamMember?.email || this.calEvent.organizer.email];
    const attendeeName = this.calEvent.attendees[0].name;
    // Locales name the attendee variable differently ({{name}}/{{user}} or {{userName}}); pass both.
    const subject = this.t("refund_failed_subject", {
      eventType: this.calEvent.type,
      name: attendeeName,
      userName: attendeeName,
      date: this.getFormattedDate(),
    });

    return {
      from: `${EMAIL_FROM_NAME} <${this.getMailerOptions().from}>`,
      to: toAddresses.join(","),
      subject,
      html: await renderEmail("OrganizerPaymentRefundFailedEmail", {
        calEvent: this.calEvent,
        attendee: this.calEvent.organizer,
        subject,
      }),
      text: this.getTextBody(
        "a_refund_failed",
        `${this.t("refund_failed_payment_not_returned")} ${this.t("check_with_provider_and_user", {
          user: attendeeName,
          userName: attendeeName,
        })}`,
        this.calEvent.paymentInfo
          ? this.t("error_message", {
              errorMessage: this.calEvent.paymentInfo.reason,
            })
          : " "
      ),
    };
  }
}
