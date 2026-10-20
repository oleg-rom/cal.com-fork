# Counseling form fixes (20 October 2026)

Base: upgrade/v6.2.0 at 1d23cd730b, containing deployed application revision 77ddc3d561. This branch does not target the stale application main.

## Live configuration

The malformed privacy acknowledgement URL was repaired through the Cal.com editor for the five active events: single, free, package4, package12, sozo. Required flags, phone, age, consent identifiers, prices, integration credentials and refund policies were preserved. No booking or payment was submitted. The corrected link was checked after reloading each event editor. Hidden legacy event types were outside this change.

## Application change (not deployed)

Only the session host with both existing consent fields receives the override. Other hosts retain upstream behavior.

- Translate age, consultation topic, privacy acknowledgement and sensitive-data consent labels into ru/en/uk/de using normal translation files. Field identifiers, required flags and response values remain unchanged. Future changes to this wording must be made in these translations; editing the stored Russian label alone does not change the localized display.
- Use published Russian and English privacy notices. Ukrainian links to the Russian notice, German to the English notice; the policy documents themselves are not translated here.
- Replace the generic acceptance of Cal.com's terms with an informational link to the executor's privacy notice. This is not contract acceptance.
- Explain that the displayed price excludes VAT and applicable VAT and the final total are shown in Stripe before payment. Free events do not show this notice. No tax calculation changes.

## Verification

13 focused Vitest 4.0.16 tests passed, using i18next 23.2.3. A strict TypeScript check of the new helper and test passed with TypeScript 5.9.3. Tooling was installed outside the repository, with no dependency or lockfile changes. Biome checked the changed TypeScript components/helper/tests with no errors; pre-existing warnings remain.

Full yarn type-check:ci --force was attempted but could not run: the fresh checkout has no installed node_modules state file. This is not a successful application-wide type check. Before merging or deploying, complete immutable dependency installation, full type checking and candidate-image browser checks. Do not infer end-to-end booking or payment verification from the focused tests.

The original checkout's unrelated modifications were not used or overwritten. No schema, migration, payment or deployment file changes.

## Remaining legal workflow

The edited document supplied in chat is explicitly a working revision 1.4 with placeholders and a 50% cancellation rule that the owner later rejected. Do not publish it unchanged. Site PR #5 contains a different unmerged draft (1.6). Resolve the authoritative final text before linking a mandatory contract acceptance to it.

Still required, and not implemented by this presentation fix:

1. Publish the agreed terms and withdrawal information with versioned document URLs.
2. Separate acceptance of terms from privacy acknowledgement and explicit sensitive-data consent.
3. Conditional, unchecked request to begin services within the 14-day withdrawal period, validated on the server, including delayed payments, rescheduling and packages. Choosing an early date or merely beginning the service must not be presented as automatic loss of the right.
4. Record accepted document version/hash, exact consent text, locale and server timestamps alongside the booking; determine formation from acceptance plus successful payment.
5. Deliver the accepted documents and withdrawal information in the confirmation email in durable form.
6. Configure and test the existing 24-hour rescheduling restriction (minimumRescheduleNotice). The inspected single event had it unset. Explain that the management link is in the booking confirmation email. This branch does not change that setting.

Do not mark the overall legal flow complete based on this PR.
