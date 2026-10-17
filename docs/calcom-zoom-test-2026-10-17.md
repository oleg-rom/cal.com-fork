# Проверка S1/S2 с Zoom и сбоя создания встречи — 2026-10-17

- Кандидат: `ghcr.io/oleg-rom/cal.com-fork@sha256:54cad2745fe4fc2865b362d793b0dc324a8f1e0175ee17960f975b7d2c15126a`, запуск по digest, код не менялся.
- Stripe: то же изолированное окружение Sandbox (`acct_1SsK…`, ключи `sk_test_`/`pk_test_`, `stripe listen`), что и в `calcom-stripe-testmode-2026-10-17.md`. Live mode, рабочий endpoint, production и n8n не затрагивались.
- Zoom: **отдельное тестовое приложение Zoom владельца** (General App, User-managed). Client ID и secret владелец ввёл в `stripe-test/zoom-test.env` (600); в отчёте, журналах и git их нет. Рабочий аккаунт Zoom не использовался.
- Для OAuth Zoom нужен HTTPS redirect: `http://localhost:3000` и `http://127.0.0.1:3000` Zoom отклоняет (4700 «Invalid redirect»). Поэтому добавлен Caddy с `tls internal` только на `127.0.0.1/::1:3443`, адрес `https://cal.localtest.me:3443`; наружу ничего не опубликовано. CoreDNS-allowlist расширен до `stripe.com` и `zoom.us`.
- Синтетика: организатор `host@example.com`, событие 100 € с местом `integrations:zoom` (credential 2), клиенты `client+s7…`/`client+s8…@example.com`, оплата картой 4242 вручную владельцем в Stripe Checkout.

## 1. Полный сценарий (s7, booking 9)

| Проверка | Результат |
|---|---|
| Бронь → оплата | `checkout.session.completed` (paid) → 200; Booking `accepted`, `paid=true`; Payment `success=true` |
| PaymentProcessing | `COMPLETED`, attempts=1, bookingPaid 1/✓, confirmation 1/✓, `lastError` пусто |
| Встреча Zoom | один `BookingReference` `zoom_video`, meetingId `…1041`, `meetingUrl` `https://us05web.zoom.us/j/…1041?pwd=…` (пароль в отчёт не включён), credentialId 2 |
| Письмо клиенту | одно, ссылка на ту же встречу, вложение `event.ics`; организатору одно |
| Повторы | `completed` повторно, три одновременных повтора, `payment_intent.succeeded` → 200/204; refs по-прежнему 1, писем не прибавилось, строка PaymentProcessing не изменилась (attempts, StartCount, `updatedAt`) |

Встреча существует со стороны Zoom: при создании Zoom ответил 201, id и ссылку выдал сам Zoom. Через API её не перечитать: у тестового приложения нет scope `meeting:read:*`.

Проверка владельцем:
- **Подтверждено.** Ссылка «Zoom Video beitreten» у s8 в списке Bookings открывает в Zoom Workplace встречу **…1900** с названием «Synthetic paid consultation zwischen Synthetic Host und Client s8-zoom-outage». Организатор встречи — тестовый аккаунт владельца. Цепочка «восстановление → BookingReference → ссылка в Cal.com → реальная встреча Zoom» работает.
- **Не подтверждено.** Список Meetings → Upcoming в Zoom владелец не проверял: существование …1041 (s7) и лишней …8583 (s8) и отсутствие других встреч подтверждены только ответами Zoom при создании.
- Список Bookings в UI совпадает с БД: у s7 и s8 «Bezahlt» и ссылка Zoom, у s1–s4 ссылки нет (Cal Video без Daily), у s2b и s4b «Unbestätigt / Zahlung ausstehend». У s4b платёж уже окончательно отклонён, но UI пишет «ожидает оплаты». Кнопка «Bestätigen» для неоплаченной брони блокируется сервером (`confirm.handler.ts:227-228`).

## 2. Контролируемый сбой Zoom (s8, booking 10)

Как вызван сбой: в CoreDNS тестового окружения на время одной брони убрана зона `zoom.us`. `api.zoom.us` не разрешался, Stripe работал. Токены и credential не трогались. По коду ([OAuthManager.ts:341](../packages/app-store/_utils/oauth/OAuthManager.ts#L341)) сетевая ошибка не помечает credential недействительным. Это подтвердилось: после сбоя `invalid=false`. Так моделируется недоступность Zoom или сети. Отказ Zoom с ответом API (истёкший refresh-токен `invalid_grant`, код 124, лимиты) не моделировался.

| Вопрос | Факт |
|---|---|
| Платёж | `completed` (paid) → **200**; Payment `success=true`, один платёж; Booking `accepted`, `paid=true` |
| PaymentProcessing | **`COMPLETED`**, attempts=1, bookingPaid 1/✓, confirmation 1/✓, `lastError` пусто — сбой встречи в S2 не виден |
| Журнал | `fetch failed` → `Zoom meeting creation failed` → `createMeeting failed` (`Unexpected error`) |
| BookingReference | один **пустой** `zoom_video` (uid `''`, meetingId/meetingUrl null, credentialId 2); `Booking.metadata.videoCallUrl = ""` |
| Организатор | одно письмо «[Action Required] Bestätigt: …»: в HTML блок «Defekte Integration — Wir konnten den zoomvideo-Meeting-Link nicht … hinzufügen» с советом изменить место встречи. В текстовой части, наоборот, сказано «Wir haben eine E-Mail … an alle gesendet», хотя клиенту ничего не отправлено |
| Клиент | **писем нет**. После оплаты он видит страницу брони «подтверждено», где «Wo: Zoom» без ссылки на встречу |
| Повтор событий после сбоя | не проверялся отдельно: повторная доставка при `COMPLETED` встречу не пересоздаёт (как в s7) |

Важно: ответ 200 и `COMPLETED` в PaymentProcessing **не означают**, что встреча создана. Об успехе говорит только непустой `meetingUrl` в BookingReference.

## 3. Восстановление штатным действием

Zoom возвращён в allowlist. Как организатор вызвана мутация `viewer.bookings.editLocation` с `{bookingId: 10, newLocation: "integrations:zoom", credentialId: 2}`. Её же отправляет диалог **Bookings → … → Edit location**. В тесте она вызывалась скриптом `stripe-test/recover-location.sh`.

| Проверка | Результат |
|---|---|
| Ответ | 200 «Location updated» |
| Встреча | новый `BookingReference` `zoom_video` meetingId `…8583` со ссылкой; `metadata.videoCallUrl` обновлён; страница брони показывает ссылку (после повторного вызова — на `…1900`, её открытие в Zoom подтверждено владельцем) |
| Письма | клиенту и организатору по одному «Ort geändert: …» со ссылкой на новую встречу и `event.ics` |
| Платёж | Payment один, `success=true`, Stripe не вызывался; PaymentProcessing не изменился (`updatedAt` прежний) |
| Повтор `completed` и `payment_intent.succeeded` после восстановления | 200 / 204; refs, письма, PaymentProcessing без изменений |
| **Повторный Edit location** | создал **ещё одну** встречу `…1900` и ещё два письма. Прежняя `…8583` в Zoom не удалена, её ref остался. Пустой ref 6 тоже остаётся |

Итог: оплаченную бронь можно восстановить штатным действием. Повторных списаний восстановление не создаёт. Дубли встреч и писем появляются, если действие выполнить больше одного раза.

### Как восстановить оплаченную встречу после сбоя Zoom (инструкция для организатора)

1. Найти брони без ссылки: письмо организатору «[Action Required]» или запрос `BookingReference` с `type='zoom_video'` и пустым `meetingUrl` у брони с `paid=true`.
2. Устранить причину: доступность Zoom; при «invalid_grant» или баннере переподключения — переподключить Zoom в Apps → Installed → Conferencing.
3. Bookings → Upcoming → бронь → **Edit location** → выбрать Zoom → Update. Сделать это **один раз** и не повторять при медленном ответе.
4. Проверить, что у брони появился `meetingUrl` (ссылка видна на странице брони), а клиенту ушло письмо «Location changed» («Ort geändert»). Это письмо фактически заменяет клиенту подтверждение.
5. Если действие выполнено повторно, удалить лишние встречи в веб-интерфейсе Zoom. Действующей считается последняя ссылка, указанная в письме и в `metadata.videoCallUrl`.
6. Платёж ничего делать не нужно: он уже учтён, Stripe при восстановлении не вызывается.

## 4. Находки

- **Z1 (базовый Cal.com, уточняет D2).** При сбое Zoom оплаченная бронь становится `accepted/paid`, а S2 считает обработку завершённой. Клиент не получает ни подтверждения, ни ссылки, а организатор получает только письмо. Автоматической повторной попытки нет, и S2 этот случай не видит. Это не регрессия S1/S2, но в production это ручная операция: нужен мониторинг писем «[Action Required]» или запроса из шага 1.
- **Z2 (базовый Cal.com).** Пустой `BookingReference` остаётся после неудачного создания и после восстановления. По коду `EventManager.updateVideoEvent` берёт первый ref нужного типа (`references.filter(...)[0]`). При последующем переносе брони он может выбрать пустой ref: Zoom не обновится, организатор получит ещё одно «[Action Required]». Удаление встречи при отмене также пойдёт с пустым uid. **Не проверено** практически, вывод только по коду.
- **Z3 (базовый Cal.com).** Edit location неидемпотентен: каждый вызов создаёт новую встречу Zoom и рассылает письма, а прежнюю не удаляет.
- **Z4 (базовый Cal.com).** Текстовая часть письма организатору при сбое сообщает, что письмо отправлено всем, хотя клиенту ничего не ушло.
- **Z5 (окружение).** Zoom не принимает HTTP redirect на localhost/127.0.0.1, поэтому для OAuth нужен HTTPS. В production это не проблема (там HTTPS), но redirect URL в приложении Zoom должен совпадать с `WEBAPP_URL`.

## 5. Не проверено

- Ответы Zoom API с ошибкой: `invalid_grant` с пометкой credential недействительным, код 124, 429, 5xx. Проверен только сетевой сбой.
- Встречи на стороне Zoom: через API не проверялись (нет read-scope); владелец подтвердил только действующую встречу s8 (…1900), список Upcoming не сверялся.
- Перенос и отмена брони после восстановления (Z2).
- Рабочий аккаунт Zoom и его приложение, scopes, redirect URL. Google Calendar вместе с Zoom.
- Восстановление через UI-диалог вручную: вызывалась та же tRPC-мутация, сам диалог не открывался.

## 6. Препятствия для развёртывания S1/S2

С Zoom S1/S2 работают правильно: одна встреча на оплату, повторы не создают встреч, писем и списаний, при сбое Zoom платёж учтён корректно. **Блокирующих находок по S1/S2 нет.** Z1–Z4 есть и в текущем production (поведение базового Cal.com), S1/S2 их не меняют. Остаются условия из предыдущего отчёта: решение по D1 (промокоды 100%), проверка live-конфигурации методов оплаты (D3) и подписки endpoint на `async_payment_*`. Перед развёртыванием также стоит:
- подготовить для организатора процедуру восстановления из раздела 3 и мониторинг оплаченных броней без `meetingUrl`;
- после развёртывания проверить одну реальную бронь с Zoom в рабочем аккаунте: redirect URL, scopes, токен.

Диагностика: `cal.com-fork-wt/stripe-test/diagnostics/zoom-final-state.txt` (Booking, PaymentProcessing, BookingReference, Mailpit, ответы webhook) и `zoom-app.log` (выдержка журнала приложения, `pwd` и токены замаскированы). Окружение (контейнеры `calcom-cand-*`, `stripe listen`) остановлено 2026-10-17 после сохранения результатов; снимок тестовой БД и писем Mailpit — `stripe-test/data-snapshot/` (не в git).
