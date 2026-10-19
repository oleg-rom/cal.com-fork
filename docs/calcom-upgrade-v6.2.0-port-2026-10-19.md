# Перенос форка на Cal.com v6.2.0 — 2026-10-19

Локальная подготовка, без push, PR и deploy. Production (revision `d491be09d799c65971a815b6543460910ba2f031`, образ `…@sha256:a04fcb22…`), live Stripe, cal.com-deploy и `main` не менялись.

## База

| | Значение |
|---|---|
| Цель | тег `v6.2.0` (лёгкий тег) = `1c193cca8682b33b9866c792186033f7ef886682`, 2026-03-01; GitHub release `v6.2.0` в `calcom/cal.diy` опубликован 2026-03-01T23:49Z |
| Не используется | `upstream/main` = `6bfe2df9…` (Cal.diy после закрытия Cal.com) |
| Prod-база форка | `1f28504db1` (`v6.1.0-27`) — предок `v6.2.0`, +553 коммита upstream |
| Ветка | `upgrade/v6.2.0`, worktree `cal.com-fork-wt/upgrade-v6.2.0`, 28 коммитов поверх `v6.2.0` |
| Эталон для сравнения | `cal.com-fork-wt/base-v6.2.0` (detached `v6.2.0`, зависимости установлены) |

Сверка с аудитом 2026-10-16:
- выводы о базе, цели, 32 миграциях, лицензиях и переносе локалей в `packages/i18n/locales` подтвердились;
- дефекты из §5.1 аудита (возврат по `cs_…`, async-события SEPA) исправлены в S1/S3 и переносятся;
- новое после аудита: S1/S2/S3, миграция S2 и её порядок относительно новых миграций upstream (см. ниже).

## Способ переноса

`git cherry-pick -x` собственных коммитов `1f28504db1..d491be09d7` по одному, в исходном порядке. Merge-коммиты не переносились: их PR-коммиты перенесены по отдельности. Каждый конфликт разобран по смыслу.

Пропущены (только журнал сессий, без кода):
- `33b7aef5de` (`codex.md`);
- `193102e976` (`codex.md` и `logs/0_build.txt`, 4620 строк).

Перенесены (26):
- **CI и документы:** `b008c502e6` Initial commit (GHCR-workflow, README_FORK/MASTER, `codex.md`), `e78c24e323`, `b0b2e57f41`, `e007116b79`, `130e7f8f5e`;
- **Stripe до S1:** `d602568066`, `96a4998679`, `a048883d0e` (direct mode), `8006426888` (Checkout + tax), `5c326e7a9c` (отладочный лог, оставлен для паритета с production), `010ea45fef`, `2693aa4994`, `7e19722dc7` (промокоды и redirect);
- **брендинг и UI:** `cfdb41d940` (письма и локали INGA LIFE), `66817fb17b` (подсказка о часовом поясе, логотип);
- **Docker и lockfile:** `066da580a4`, `db68251d3b`, `2ba06c6d2f`;
- **S1/S2/S3:** `e21cb5210e` (S1), `97e8772910` (S2 со схемой и миграцией), `433a6993b4`, `c64f52cf66`, `305e20d3d6`, `ba959a9bb0`, `8c71a5daaf` (S3), `d491be09d7` (отчёт S3).

Адаптации к v6.2.0 (новые коммиты):
- `784c04045f`: тест письма S3 импортирует `getTranslation` из `@calcom/i18n/server` (раньше `@calcom/lib/server/i18n`, перенесено в #28141);
- `2ccf672e3a`: убран неиспользуемый второй аргумент `Error(message, options)` в `StripeRefundError`. В `v6.2.0` `tsc` для `packages/lib` не знает этой сигнатуры ES2022. Поведение не изменилось.

## Конфликты и решения

| Файл / коммит | Решение |
|---|---|
| `.gitignore` (Initial commit) | В форке файл был сокращён до одной строки `.env`. Из-за этого `node_modules` и сгенерированные каталоги отображались как неотслеживаемые. Взят полный `.gitignore` из `v6.2.0` (`.env` в нём игнорируется). На образ не влияет (сборка использует `.dockerignore`) |
| `webhook.ts` (`8006426888`) | Upstream только переформатировал файл: токены совпадают без учёта запятых, точек с запятой и комментариев. Взята версия форка. Итоговый файл байт в байт совпадает с production |
| локали (`cfdb41d940`) | В `v6.2.0` они перенесены из `apps/web/public/static/locales` в `packages/i18n/locales`. Изменения применены по ключам, а не построчно. 174 из 178 собственных значений совпадают с production. 4 — пустые в `v6.2.0` локали `iw` и `th` (`{}`, действует английский запасной текст), они оставлены пустыми. Дубликаты `skip_trial`/`routing_forms` upstream убрал сам, оставлено значение upstream |
| `codex.md` | Документ, взята версия форка |
| `handlePaymentSuccess.ts` (S2) | Взята версия S2 и в неё перенесены 3 изменения upstream: `assignmentReason` убран из payload `BOOKING_PAID` (#27891), `hideBranding` из `evt` (#27643), `oAuthClientId` в `handleBookingRequested` (#27546) |
| `errorCodes.ts` (S3) | Сохранены оба кода: `CollectCardFailure` (upstream) и `PaymentRefundFailure` (S3) |
| `OrganizerPaymentRefundFailedEmail.tsx` (S3) | Строка S3 о невозврате и обе формы переменной вместе с `interpolation: { escapeValue: false }` из upstream |

Контроль результата:
- 26 собственных файлов, которые upstream не менял, байт в байт совпадают с production;
- 9 файлов с изменениями upstream дали чистое трёхстороннее слияние, совпадающее с итогом;
- 4 файла разрешены вручную, как в таблице.

Схема `PaymentProcessing` (+49 строк) и миграция `20261016120000_add_payment_processing` перенесены без изменений.

## Миграции

`v6.2.0` добавляет 32 миграции к нынешним 557; итог — 589. Ни одна не трогает `Payment` и `PaymentProcessing`.

| Тип | Миграции |
|---|---|
| **Удаляют данные (необратимо)** | `20260122145500_drop_user_starttime_endtime` (`DROP COLUMN users.startTime/endTime`); `20260120093500_add_no_show_updated_audit_action` (пересоздание enum `BookingAuditAction`, значения `host_/attendee_no_show_updated` сливаются в `no_show_updated`) |
| **Меняют поведение через данные** | `20260129090913_enable_pbac_globally` (`Feature pbac → enabled`), `20260213000000_enable_onboarding_v3_globally` (`onboarding-v3 → enabled`) |
| **Добавляют строки** | `20260129170000_pbac_add_password_reset_permission`, `20260210142544_add_audit_logs_permissions_to_admin_role` (`RolePermission`); `20260130100000_add_high_water_mark_fields`, `20260210000000_add_billing_mode`, `20260212202500_add_signup_watchlist_review_feature` (флаги `Feature`, выключены) |
| **Расширяют enum** | `20260119113000_add_system_source`, `20260122133147_add_wrong_assignment_webhook`, `20260212202500_…`, `20260218000000_add_routing_form_fallback_hit_webhook_trigger` |
| **Аддитивные** (таблицы, колонки, индексы) | остальные 19, в том числе `Credential.encryptedKey`, индексы `Booking`/`Attendee`/`EventType`/`Credential` |

**Порядок.** Все 32 миграции датированы раньше миграции S2 (`20261016120000`). Самая старая (`20260114154054`) раньше и последней уже применённой в production (`20260115155453`). Prisma применяет их без ошибок «задним числом». Проверено на изолированных копиях:
- **пустая база:** 589 за 3 с; интеграционные тесты S2 на этой схеме — 33/33;
- **копия production-дампа** от 2026-10-17 23:22 (557): 32 миграции за ~1 с. Без изменений остались число строк (Booking 290, Payment 151, BookingReference 479, Credential 6, EventType 7, Webhook 5), md5 `EventType.bookingFields` (настройки согласий) и `metadata`, md5 `Booking.responses`, md5 `Credential.key`. Изменились только флаги `pbac` и `onboarding-v3` (`false → true`). Перед миграцией у единственного пользователя `startTime`/`endTime` имели значения по умолчанию (0/1440), `BookingAudit` пуст;
- **синтетический снимок с данными S2** (7 строк `PaymentProcessing`): md5 `PaymentProcessing` и `Payment` до и после совпадают.

## Риски отката

- **Возврат только прежнего образа после миграций не работает.** Проверено: образ S3 (`a04fcb22…`) на мигрированной копии стартует («557 migrations found … No pending»), но `/session` и страницы событий отвечают **500**. Причина — P2022 в `prisma.user.findMany()`: удалены `users.startTime/endTime`.
- **Возможен откат без восстановления дампа**, если перед возвратом прежнего образа выполнить совместимый SQL:

  ```sql
  ALTER TABLE "users" ADD COLUMN "startTime" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "endTime" INTEGER NOT NULL DEFAULT 1440;
  ```

  Проверено на изолированной копии: после этого все проверенные страницы отвечают 200, новых ошибок схемы нет.
  - **Не проверено:** запись аудита no-show старым кодом. В enum нет значений `host_no_show_updated`/`attendee_no_show_updated`, дополнительно нужен `ALTER TYPE "BookingAuditAction" ADD VALUE …`.
  - **Не откатываются:** флаги `pbac`/`onboarding-v3` и новые строки `RolePermission`/`Feature`.
- **Восстановление дампа** остаётся крайней мерой: оно теряет брони и платежи после обновления (как в `RUNBOOK-S1-S2.md`, 8C).

## Окружение и интеграции

- **Без изменений:** Node 20 (`node:20` в Dockerfile, плавающий тег), Yarn 4.12.0, Prisma 6.16.1, React 18.2.0, `stripe` 9.16.0. Next 16.1.0 → 16.1.5.
- **PostgreSQL:** production 16, требований к обновлению нет. Миграции проверены на 16.14.
- **Stripe:** `ee/payments/api/webhook.ts` у upstream изменён только форматированием. В `stripepayment` upstream:
  - CSRF-nonce в OAuth state (#28083, использует `NEXTAUTH_SECRET`; касается только нового подключения Stripe OAuth, в direct mode не используется);
  - `CollectCardFailure` (#27249);
  - перенос репозиториев (#27570).

  Direct mode, Checkout, промокоды, S1/S2/S3 перенесены.
- **Zoom:** изменено только описание в `_metadata.ts`. Общий OAuth получил CSRF-nonce: уже подключённые credentials не затронуты, переподключение подписывает state через `NEXTAUTH_SECRET`.
- **Google Calendar:** новая колонка `Credential.encryptedKey` с откатом на прежний `key`. Шифрование включается, только если задан ключ шифрования, так что при пустом `CALCOM_APP_CREDENTIAL_ENCRYPTION_KEY` (как в production) всё работает по-старому. Есть также ссылка Google Meet в месте встречи и исправления ошибок.
- **Лицензии** (файлы `LICENSE` в `v6.2.0`, без изменений относительно базы): `packages/features/ee/**` (в том числе используемый `ee/payments`: webhook и страница оплаты) и `packages/app-store/stripepayment` — Cal.com Commercial License, для production требуется подписка Cal.com. Остальное — AGPLv3. Это не юридическое заключение.

## Проверки

| Проверка | Результат |
|---|---|
| Чистая установка `yarn install --immutable` | ветка: exit 0, 52 с; эталон `v6.2.0`: exit 0 |
| Проверка lockfile из Dockerfile (симуляция частичной установки) | незакреплённых версий 0 (62 отброшенных записи — `apps/api`/`example-apps`, ожидаемо) |
| Тесты S1/S2/S3 | 18 наборов, 254 теста (все прошли после исправления импорта; 60 тестов возврата повторно после адаптации `StripeRefundError`) |
| Интеграционные тесты S2 (PostgreSQL) | 33/33 |
| `tsc --noEmit` против чистого `v6.2.0` | `app-store` 0/0, `trpc` 0/0; `lib` 106/106, `emails` 152/152, `features` 108/108, `apps/web` 1530/1530 — исходные ошибки v6.2.0, **новых нет** (одна новая в `refundPayment.ts` исправлена). Полностью зелёной проверку назвать нельзя |
| Biome по вручную слитым строкам | чисто |

## Что v6.2.0 не исправляет

- **Безопасность зависимостей:** handlebars 4.7.7, axios 1.13.5, protobufjs 7.4.0, follow-redirects 1.15.11. Исправления Cal.diy после релиза (`0936fdafaf`, `2911168e4e`, `4313bd2dc5`, `363c9d6331`) и кода (`038381aeca` banlist IP, `0d164da8dd` проверка пароля, `b97cd6203d` security audit) в `v6.2.0` не входят. Это отдельное изменение после переноса.
- **Собственные открытые пункты:**
  - D1: промокоды 100% (`apiVersion 2020-08-27`);
  - D3: асинхронные методы оплаты в live;
  - отмена не закрывает Checkout Session (S5);
  - лог полного PaymentIntent (S11);
  - новый `Price` на каждую бронь;
  - синхронизация возвратов (S6);
  - уведомление при `requires_action`;
  - сырые ключи в HTML-заголовке писем (`docs/calcom-task-email-title-keys-2026-10-17.md`);
  - отладочный лог «Webhook mode check».
- **Брендинг:** коммит `cfdb41d940` записывает русские тексты и в другие языки (как в production).

## Препятствия перед сборкой кандидата обновления

1. Push `upgrade/v6.2.0` и сборка через `workflow_dispatch`: push в ветку с таким именем автоматическую сборку не запускает.
2. Docker-сборка (`next build` на Next 16.1.5, локали в `packages/i18n`) локально не выполнялась.
3. Полный `type-check:ci` (turbo) не выполнялся. Прямой `tsc` показывает исходные ошибки `v6.2.0`, в том числе 1530 в `apps/web`.
4. Сценарии на собранном образе ещё предстоит проверить:
   - Stripe Sandbox (оплата, SEPA, возвраты S3);
   - Zoom и Google;
   - письма и локали в новом пакете i18n;
   - согласия в форме бронирования (form-builder менялся);
   - `seed-app-store` (Stripe/Zoom включены);
   - payload webhook для n8n (#27891 изменил payload);
   - поведение с включёнными `pbac` и `onboarding-v3`.
5. Решение по откату: совместимый SQL или только восстановление дампа.
6. Лицензионный вопрос EE (подписка) — без изменений.
