/**
 * @vitest-environment node
 */

import { getTranslation } from "@calcom/lib/server/i18n";
import type { CalendarEvent } from "@calcom/types/Calendar";
import { describe, expect, it } from "vitest";

import OrganizerPaymentRefundFailedEmail from "./organizer-payment-refund-failed-email";

class RenderedRefundFailedEmail extends OrganizerPaymentRefundFailedEmail {
  payload() {
    return this.getNodeMailerPayload();
  }
}

async function render(organizerLocale: string, attendeeLocale = "en") {
  const organizerT = await getTranslation(organizerLocale, "common");
  const attendeeT = await getTranslation(attendeeLocale, "common");
  const calEvent: CalendarEvent = {
    type: "Paid consultation",
    title: "Paid consultation between Host and Client",
    startTime: "2026-11-02T06:00:00.000Z",
    endTime: "2026-11-02T07:00:00.000Z",
    organizer: {
      name: "Synthetic Host",
      email: "host@example.com",
      timeZone: "Europe/Berlin",
      language: { translate: organizerT, locale: organizerLocale },
    },
    attendees: [
      {
        name: "Client Example",
        email: "client@example.com",
        timeZone: "Europe/Berlin",
        language: { translate: attendeeT, locale: attendeeLocale },
      },
    ],
    paymentInfo: {
      reason: "Stripe refund of payment 7 failed (temporary error): no connection",
      id: "pay-uid-7",
    },
  };
  const payload = (await new RenderedRefundFailedEmail({ calEvent }).payload()) as {
    subject: string;
    html: string;
    text: string;
  };
  return { ...payload, organizerT };
}

// React escapes text in HTML output.
const inHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

// A literal {{variable}} or a raw translation key left in the output means a broken translation call.
const RAW_KEY =
  /\b(refund_failed_subject|a_refund_failed|check_with_provider_and_user|refund_failed_payment_not_returned|error_message)\b/;

describe("OrganizerPaymentRefundFailedEmail", () => {
  it.each([
    "en",
    "ru",
    "uk",
    "de",
  ])("renders in the organizer's locale %s without raw keys or placeholders", async (locale) => {
    const { subject, html, text, organizerT } = await render(locale);

    for (const output of [subject, html, text]) {
      expect(output).not.toMatch(/\{\{\s*\w+\s*\}\}/);
      expect(output).not.toMatch(RAW_KEY);
    }
    expect(subject).toContain("Client Example");
    expect(subject).toContain("Paid consultation");
    expect(html).toContain(inHtml(organizerT("a_refund_failed")));
    expect(html).toContain(inHtml(organizerT("refund_failed_payment_not_returned")));
    expect(html).toContain(`<title>${inHtml(subject)}</title>`);
    expect(html).toContain("pay-uid-7");
  });

  it("uses the organizer's locale, not the attendee's", async () => {
    const { subject, html } = await render("uk", "ru");
    const uk = await getTranslation("uk", "common");
    const ru = await getTranslation("ru", "common");

    expect(html).toContain(inHtml(uk("refund_failed_payment_not_returned")));
    expect(html).not.toContain(inHtml(ru("refund_failed_payment_not_returned")));
    expect(subject.startsWith(uk("a_refund_failed").slice(0, 10))).toBe(true);
  });
});
