# Проверка S1/S2 в Stripe Sandbox — 2026-10-17

- Кандидат: `ghcr.io/oleg-rom/cal.com-fork@sha256:54cad2745fe4fc2865b362d793b0dc324a8f1e0175ee17960f975b7d2c15126a` (исходники `2ba06c6d2fe6438134bde20bb2d8c53a438d52cf`), запуск по digest, код не менялся.
- Stripe: Sandbox аккаунта `acct_1SsK…` (Sandbox владельца, DE, EUR), ключи `sk_test_`/`pk_test_` введены владельцем в `cal.com-fork-wt/stripe-test/stripe-keys.env` (600); в отчёте, журналах и коде их нет. Live mode, рабочий endpoint и production не затрагивались.
- Stripe CLI 1.53.1 с изолированным пустым конфигом (обычный вход CLI относится к другому аккаунту и не использовался). `stripe listen` → `localhost:3000`, секрет этой сессии записан в `webhook.env` (600). События: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.succeeded`.
- Окружение: podman, внутренняя сеть без DNS и выхода наружу для PostgreSQL 16.14 (tmpfs), Redis, Mailpit; приложение дополнительно в egress-сети с CoreDNS-allowlist: разрешается только `*.stripe.com` (проверено: `api.stripe.com` 401 без ключа, остальные имена — `ENOTFOUND`). Порты только `127.0.0.1:3000` и `127.0.0.1:18025`. Ограничение: это DNS-allowlist, прямые соединения по IP не блокируются.
- Настройки Sandbox (с разрешения владельца, только test): SEPA Direct Debit включён в собственной конфигурации методов оплаты `pmc_1SsKW1…`; тестовые купон 100% и промокод (только Sandbox). Stripe Tax в Sandbox уже был активен.
- Синтетика: организатор `host@example.com`, клиенты `client+<сценарий>@example.com`, платное событие 100,00 € (net). Брони создавались через публичный `/api/book/event`, отмена — через `/api/cancel` с CSRF-токеном, оплата — вручную владельцем в реальном Stripe Checkout.
- Zoom и Google не подключены: реальное создание встреч не проверялось. Брони s1–s5 использовали место по умолчанию (Cal Video без ключа Daily, создание встречи неуспешно), s6 и последующие — статическую ссылку.

## Результаты

| Сценарий | События и HTTP-ответ webhook | Booking / Payment | PaymentProcessing | Письма (Mailpit) |
|---|---|---|---|---|
| s1 карта 4242 | `payment_intent.succeeded` 204; `checkout.session.completed` (paid) 200 | accepted, paid / success=true | COMPLETED, attempts=1, bookingPaid 1/✓, confirmation 1/✓ | организатор 1 («[Action Required]», см. D2), клиент 0 |
| s6 карта 4242, статическая ссылка | `completed` (paid) 200 | accepted, paid / success=true | COMPLETED, attempts=1, шаги по 1 | клиент 1, организатор 1 |
| s2, s3, s4 SEPA `DE08…3003` (отложенный успех) | `completed` (unpaid) **202**; через 4–5 мин `async_payment_succeeded` 200 | до успеха: pending, paid=false, строки нет; после — accepted, success=true | COMPLETED, attempts=1, шаги по 1 | организатор по 1 («[Action Required]»), клиенты 0 |
| s4b SEPA `DE78…3004` (отложенная неудача) | `completed` (unpaid) 202; через ~8 мин `async_payment_failed` 200; повтор события 200 | pending, paid=false / success=false, `asyncPaymentFailure` записан | строки нет | 0 |
| s5 оплата отменённой брони, карта | `completed` (paid) 200 | **cancelled** (не восстановлена) / success=true, `manualSettlementRequired` | строки нет | только письма об отмене (клиент 1, организатор 1) |
| s2b промокод 100% | — | pending | — | 0 — **оплата невозможна** (D1) |

Повторная доставка (`stripe events resend`, подписанные события через ту же сессию CLI):

| Проверка | Ответы | Изменения |
|---|---|---|
| T1: повтор `completed` s6 после успеха | 200 | нет |
| T2: три одновременных повтора `completed` s6 | 2 доставки (Stripe/CLI объединили одну), обе 200 | нет |
| T3: одновременно `completed` (unpaid-снимок) и `async_payment_succeeded` s3 | 202 и 200 | нет |
| Повтор `async_payment_failed` s4b | 200 | нет |

После всех повторов: в Mailpit по-прежнему 8 писем, строки `PaymentProcessing` идентичны снимку до повторов (attempts, StartCount, `updatedAt`).

Параллельность здесь проверена только для уже завершённой обработки. Гонка двух первых доставок (захват аренды, блокировка в PostgreSQL) доказана интеграционными тестами S2 и через Stripe не воспроизводилась.

## Находки

- **D1 (форк, новое). Промокод 100% не работает.** Checkout отклоняет его: «This promotion code cannot be applied because it reduces the total to zero. Upgrade your API version to 2023-08-16 to accept no-cost orders». Причина — `apiVersion: "2020-08-27"` в `packages/app-store/stripepayment/lib/PaymentService.ts` (и `packages/features/ee/payments/server/stripe.ts`). Ветка S1 `no_payment_required` в Stripe сейчас недостижима (проверена только тестами). Исправление — отдельной задачей: передавать `apiVersion` ≥ `2023-08-16` для `checkout.sessions.create` (или обновить версию целиком) с регрессионной проверкой Checkout, webhook и возвратов; либо не использовать промокоды на 100%.
- **D2 (базовый Cal.com, не S1/S2). Без созданной встречи клиент не получает подтверждение.** Если все интеграции встречи падают, `handleConfirmation` пропускает подтверждения, организатор получает `BrokenIntegrationEmail` («[Action Required]»), шаг S2 считается выполненным (ошибка не пробрасывается). В production это сценарий сбоя Zoom (например, истёкший токен).
- **D3 (подтверждение S1).** Даже с версией API 2020-08-27 Checkout предлагает динамические методы оплаты аккаунта (`card, bancontact, eps, ideal, sepa_debit, klarna, multibanco, link, …`), включая асинхронные. Нужно проверить конфигурацию методов оплаты live-аккаунта: без S1 любой асинхронный метод подтверждает бронь до оплаты.
- **D4.** Налог во всех сессиях 0 € (`amount_total` 10000): Stripe Tax в Sandbox активен, но регистраций нет. Live-настройки не проверялись; налоговые правила здесь не определяются.
- Подтверждены известные пункты аудита: отмена не закрывает Checkout Session (S5) — сессия s5 оставалась `open` после отмены; обработчик `payment_intent.succeeded` для Checkout-платежей отвечает 204 и пишет весь PaymentIntent в журнал (S11).

## Не проверено

Zoom/Google и реальная видеовстреча; первая доставка, параллельная внутри Stripe; позднее неудачное событие после успешной оплаты (Stripe его не порождает, проверено тестами); возвраты (S3); live-конфигурация Stripe (методы оплаты, налоги, подписка endpoint на два новых события); работа n8n с событиями кандидата.

## Готовность

S1 и S2 ведут себя в Stripe Sandbox так, как задумано: оплата картой, отложенный успех и неудача SEPA, повторы, параллельные повторы, разные события одного платежа и оплата отменённой брони. Кандидат готов к следующему этапу при условии решения по D1 (промокоды 100%) и проверки live-конфигурации Stripe (D3) перед развёртыванием; Zoom-путь (D2) стоит проверить отдельно на тестовом аккаунте Zoom.

Диагностика: `cal.com-fork-wt/stripe-test/diagnostics/` (журнал `stripe listen` с замаскированным секретом, итоговые состояния, выдержка журнала приложения, список писем Mailpit).
