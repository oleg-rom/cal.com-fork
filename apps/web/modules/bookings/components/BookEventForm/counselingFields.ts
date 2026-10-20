import type { TFunction } from "i18next";

const labels: Record<string, { type: string; key: string }> = {
  age: { type: "number", key: "inga_booking_age" },
  request: { type: "textarea", key: "inga_booking_request" },
  privacy_acknowledgement: {
    type: "boolean",
    key: "inga_booking_privacy_acknowledgement",
  },
  sensitive_data_consent: {
    type: "boolean",
    key: "inga_booking_sensitive_data_consent",
  },
};
type Field = { name: string; type: string };
export function isCounselingForm(username: string | null, fields: readonly Field[]): boolean {
  return (
    username === "session" &&
    ["privacy_acknowledgement", "sensitive_data_consent"].every((name) =>
      fields.some((field) => field.name === name && field.type === "boolean")
    )
  );
}
export function getCounselingPrivacyUrl(language: string): string {
  const locale = language.toLowerCase().split(/[-_]/)[0];
  return `https://inga.life/${locale === "ru" || locale === "uk" ? "" : "en/"}privacy-policy/`;
}
export function getCounselingFieldLabel(field: Field, t: TFunction, language: string): string | undefined {
  const entry = Object.hasOwn(labels, field.name) ? labels[field.name] : undefined;
  if (!entry || entry.type !== field.type) return undefined;
  return t(entry.key, {
    privacyUrl: getCounselingPrivacyUrl(language),
    interpolation: { escapeValue: false },
  });
}
