---
worth: yes
priority: p2
where: extensions/codex-status.ts:44
added: 2026-10-03
---
# codex-status: захардкоженный User-Agent и SIGTERM без эскалации

Python-мост шлёт `User-Agent: codex-cli/0.144.1` — версия дрейфует от реального CLI и может перестать проходить проверки chatgpt.com. При таймауте процессу отправляется только SIGTERM без эскалации SIGKILL — зависший python может пережить таймаут. Исправление: вынести версию в константу/обновляемое место и добавить SIGKILL через грейс-период (по образцу ralphex watchdog).
