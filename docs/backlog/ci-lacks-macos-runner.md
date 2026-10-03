---
worth: yes
priority: p2
where: .github/workflows/ci.yml:17
added: 2026-10-03
---
# CI не покрывает macOS

Матрица — только ubuntu-latest, при том что основное использование — macOS, а в коде есть платформенные ветки (`ps -axo`, `taskkill`, проверки mode-бит 0600/0700, skip на win32). Добавить macos-latest в матрицу, чтобы платформенные пути не деградировали молча.
