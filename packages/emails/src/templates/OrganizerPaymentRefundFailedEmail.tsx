import { BaseEmailHtml } from "../components";
import type { OrganizerScheduledEmail } from "./OrganizerScheduledEmail";

export const OrganizerPaymentRefundFailedEmail = (
  props: React.ComponentProps<typeof OrganizerScheduledEmail> & { subject?: string }
) => {
  const t = props.calEvent.organizer.language.translate;
  const attendeeName = props.calEvent.attendees[0].name;

  return (
    <BaseEmailHtml
      headerType="xCircle"
      subject={props.subject ?? t("a_refund_failed")}
      title={t("a_refund_failed")}
      callToAction={null}
      subtitle={
        <>
          {t("refund_failed_payment_not_returned")}{" "}
          {/* Locales name the attendee variable {{user}} or {{userName}}; pass both. */}
          {t("check_with_provider_and_user", { user: attendeeName, userName: attendeeName })}
        </>
      }>
      <RefundInformation {...props} />
    </BaseEmailHtml>
  );
};

function RefundInformation(props: React.ComponentProps<typeof OrganizerPaymentRefundFailedEmail>) {
  const { paymentInfo } = props.calEvent;
  const t = props.calEvent.organizer.language.translate;

  if (!paymentInfo) return null;

  return (
    <>
      {paymentInfo.reason && (
        <tr>
          <td align="center" style={{ fontSize: "0px", padding: "10px 25px", wordBreak: "break-word" }}>
            <div
              style={{
                fontFamily: "Roboto, Helvetica, sans-serif",
                fontSize: "16px",
                fontWeight: 400,
                lineHeight: "24px",
                textAlign: "center",
                color: "#494949",
              }}>
              {t("error_message", { errorMessage: paymentInfo.reason }).toString()}
            </div>
          </td>
        </tr>
      )}
      {paymentInfo.id && (
        <tr>
          <td align="center" style={{ fontSize: "0px", padding: "10px 25px", wordBreak: "break-word" }}>
            <div
              style={{
                fontFamily: "Roboto, Helvetica, sans-serif",
                fontSize: "16px",
                fontWeight: 400,
                lineHeight: "24px",
                textAlign: "center",
                color: "#494949",
              }}>
              {t("payment")} {paymentInfo.id}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
