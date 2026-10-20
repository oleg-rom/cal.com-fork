import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { getCounselingFieldLabel, getCounselingPrivacyUrl, isCounselingForm } from "./counselingFields";

const fields = [
  { name: "privacy_acknowledgement", type: "boolean" },
  { name: "sensitive_data_consent", type: "boolean" },
];
it("only overrides the intended host with both consent fields", () => {
  expect(isCounselingForm("session", fields)).toBe(true);
  expect(isCounselingForm("other", fields)).toBe(false);
  expect(isCounselingForm(null, fields)).toBe(false);
  expect(isCounselingForm("session", fields.slice(0, 1))).toBe(false);
  expect(
    isCounselingForm(
      "session",
      fields.map((f) => ({ ...f, type: "text" }))
    )
  ).toBe(false);
});
it.each([
  ["ru", "https://inga.life/privacy-policy/"],
  ["uk-UA", "https://inga.life/privacy-policy/"],
  ["en-GB", "https://inga.life/en/privacy-policy/"],
  ["de-DE", "https://inga.life/en/privacy-policy/"],
])("links to a published policy for %s", (language, expected) => {
  expect(getCounselingPrivacyUrl(language)).toBe(expected);
});
describe.each(["en", "ru", "uk", "de"])("%s translations", (language) => {
  const common = JSON.parse(
    readFileSync(
      new URL(`../../../../../../packages/i18n/locales/${language}/common.json`, import.meta.url),
      "utf8"
    )
  );
  it("localizes every managed field with valid links even when i18next escapes by default", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: language,
      resources: { [language]: { translation: common } },
    });
    for (const field of [...fields, { name: "age", type: "number" }, { name: "request", type: "textarea" }]) {
      const label = getCounselingFieldLabel(field, i18n.t, language);
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/inga_booking_|\{\{|\]\(https:\/\/\)/);
      if (field.type === "boolean") expect(label).toContain(`](${getCounselingPrivacyUrl(language)})`);
      if (field.name === "sensitive_data_consent") expect(label).toContain("mailto:privacy@inga.life");
    }
    expect(common.inga_booking_vat_notice).toBeTruthy();
  });
  it("leaves other field names and types alone", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: language,
      resources: { [language]: { translation: common } },
    });
    for (const field of [
      { name: "notes", type: "textarea" },
      { name: "age", type: "text" },
      { name: "constructor", type: "text" },
    ]) {
      expect(getCounselingFieldLabel(field, i18n.t, language)).toBeUndefined();
    }
  });
});
