---
worth: yes
priority: p1
where: extensions/ralphex/process.ts:17
added: 2026-10-03
---
# redactDiagnostic пропускает JSON-экранированные секреты

В `attempt.json` stdout хранится строкой внутри JSON, поэтому секрет в форме `\"api_key\\\":\\\"value\\\"` не матчится regex-редакцией (подтверждено проверкой: секрет оставался в логе). Реально работает только env-слой — точные значения переменных окружения. Исправление: редактировать stdout до `JSON.stringify` или расширить regex на экранированные кавычки. Заодно убрать дублирование строки `worker error:` в `workerDiagnostic` — она уже добавляется через `taskFailures`.
