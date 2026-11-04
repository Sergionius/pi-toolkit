<!-- ralphex-base: 0511f2c2faa56516500159d9d5a246095c8b04c3 -->

# Поддержка локального времени в `/later` (`HH:MM`)

<!-- plan-slug: later-absolute-local-time -->

## Goal

Разрешить планировать `/later` на конкретное локальное время настенных часов: `/later 15:01 продолжи`, `/later at 15:01 /ralphex-exec plan.md`, `/later в 9:05 ...` — наряду с существующими относительными задержками `h/m/s`, которые сохраняют прежний смысл. Время, уже прошедшее сегодня, даёт однозначную ошибку (без переката на завтра).

## Context

- `extensions/later.ts`: `parseLaterArgs(raw)` возвращает union `LaterPlan` (`schedule` с `delayMs` / `list` / `cancel` / `usage`); `parseDelayMs` разбирает только комбинации `h/m/s` (макс. 24ч); `LaterScheduler.schedule(delayMs, payload)` сам вычисляет `fireAt = now + delayMs` — поэтому абсолютное время достаточно свести к `delayMs`, планировщик не меняется.
- Подтверждение в handler'е сейчас: `Scheduled /later #<id> in <remaining>: <payload>`; `formatLaterList` уже показывает `(at HH:MM)` по `fireAt` — работает без изменений.
- Хелперы экспортированы как чистые функции; `tests/later.test.mjs` (node:test + jiti) гоняет их с фиксированными значениями, а handler — через `fakePi`.
- `USAGE`-константа и README (`README.md`, строка про `later.ts`) документируют синтаксис.
- Отдельного typecheck/lint в проекте нет; `npm test` — гейт (`node --test tests/*.test.mjs && bash tests/ask-claude.test.sh`).
- Решения, принятые с пользователем: двоеточие — маркер абсолютного времени (additive, ничего не ломается); префиксы `at` и `в` — алиасы; прошедшее время — `{ action: "error" }` с одним понятным сообщением; `HH:MM:SS` и даты — вне скоупа.

## Scope

- Разбор `HH:MM` (0≤h≤23, 0≤m≤59) и префиксов `at`/`в` в `parseLaterArgs` с опциональным параметром `now` (по умолчанию `Date.now()`, чистота и тестируемость сохраняются).
- Новый вариант плана `error` и его обработка в командном handler'е (notify с одной строкой, без USAGE-простыни).
- Подтверждение для абсолютного расписания показывает и время, и остаток: `Scheduled /later #3 at 15:01 (in 2h 07m): ...` — через опциональное поле `atLabel` в варианте `schedule`.
- Обновление `USAGE` и README; тесты в `tests/later.test.mjs`.

## Out of Scope

- Перекат прошедшего времени на завтра и любые явные даты/дни недели («завтра», `mon`).
- Секунды в абсолютном времени (`HH:MM:SS`), персистентность между сессиями, коррекция таймеров на sleep/DST (семантика `setTimeout` — как и сегодня для относительных задержек).

## Implementation Steps

### Task 1: Абсолютное время в `parseLaterArgs` и ветка `error` в handler'е

**Files:**
- Modify: `extensions/later.ts`

- [x] Добавить в `parseLaterArgs(raw: string, now: number = Date.now())` второй опциональный параметр; функция остаётся чистой.
- [x] Перед относительной веткой: если первый токен — `at` или `в` (как отдельное слово), взять следующий токен; если он не матчится как `HH:MM`, продолжить обычный разбор (fallback в `usage`, как сейчас).
- [x] Матчить первый токен на `/^(\d{1,2}):(\d{2})$/`; при несовпадении — существующая относительная логика без изменений. При матче валидировать h≤23, m≤59; невалидный диапазон → `error` с причиной вида `"25:00" is not a valid local time (HH:MM)`.
- [x] Валидное время: собрать target на «сегодня» локально из `now` (часы/минуты из токена, секунды/мс = 0); если `target <= now` → `{ action: "error", reason: "HH:MM" has already passed today. Use a future time or a relative delay like 1h30m.`; иначе `{ action: "schedule", delayMs: target - now, payload, atLabel: "HH:MM" }` — расширить вариант `schedule` опциональным `atLabel?: string`.
- [x] Добавить в `LaterPlan` вариант `{ action: "error"; reason: string }`.
- [x] В handler'е `/later`: ветка `error` → `ctx.ui.notify(plan.reason, "warning")`; в ветке `schedule` при наличии `atLabel` уведомление вида `Scheduled /later #<id> at <atLabel> (in <formatRemaining>): <preview>`, иначе — прежний текст.
- [x] Требования payload и `supported()` применяются к абсолютной форме так же, как к относительной (пустой payload → `usage`; уже реализовано общей веткой — только убедиться, что порядок проверок не сломался).
- [x] Обновить `USAGE`: `/later <delay|HH:MM> <command or message> (e.g. /later 30m /ralphex-exec plan.md | /later at 15:01 check the build) | /later list | /later cancel <id|all>`; в причине «Invalid delay» упомянуть обе формы (`h/m/s` или `HH:MM`).

### Task 2: Тесты абсолютного времени

**Files:**
- Modify: `tests/later.test.mjs`

- [ ] С фиксированным `now` (локальная `new Date(2026, 10, 4, 12, 53, 34)`): `parseLaterArgs("15:01 привет", now)` → `{ action: "schedule", delayMs: target-now, payload: "привет", atLabel: "15:01" }`; то же через `at 15:01` и `в 15:01` (deepEqual, включая `atLabel`).
- [ ] Ошибки: `"25:00 x"` и `"12:60 x"` → `error` с причиной про невалидное время; `now` = 13:00 и `"12:30 x"` → `error` «already passed today»; `"15:1 x"` и `"15:01:30 x"` не матчатся как `HH:MM` и падают в существующий `usage` с обновлённой причиной.
- [ ] Относительное без изменений: `parseLaterArgs("2h7m привет", now)` → `delayMs: 7_620_000`, без `atLabel`; существующие тесты `parseLaterArgs`/`parseDelayMs` продолжают проходить.
- [ ] E2E через `fakePi`: вычислить время из реальных часов как `new Date(Date.now() + 60_000)` и отформатировать в `HH:MM` (гарантированно будущее, без флаков на границе минуты) → `handler("<HH:MM> ping", ctx)` даёт notification, матчащий `/^Scheduled \/later #1 at \d{2}:\d{2} \(in/`, и task в `scheduler`.
- [ ] E2E ветки `error`: `handler("12:60 x", ctx)` → warning с причиной, задач не запланировано, status-строка не появляется.

### Task 3: Документация

**Files:**
- Modify: `README.md`

- [ ] Обновить строку про `later.ts`: синтаксис `/later <delay|HH:MM> <...>`, пример `/later at 15:01 check the build`, примечание что прошедшее сегодня время отклоняется (переката на завтра нет), `h/m/s` — относительные как раньше.

## Validation

- Точечно: `node --test tests/later.test.mjs`.
- Полный гейт перед завершением: `npm test`.

## Acceptance Criteria

- `/later 15:01 <payload>` планирует payload на сегодня 15:01 по локальным часам; подтверждение показывает и абсолютное время, и остаток; таск виден в `/later list` и стреляет по idle-логике как раньше.
- `/later at 15:01 ...` и `/later в 15:01 ...` работают идентично голой форме.
- Относительные `h/m/s`-задержки не изменились (существующие тесты проходят без правок).
- Прошедшее или невалидное время даёт один понятный warning и ничего не планирует; `25:00`, `12:60`, `15:1`, `15:01:30` не планируют таски.
- `npm test` проходит.
