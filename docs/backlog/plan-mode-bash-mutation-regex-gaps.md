---
worth: yes
priority: p2
where: extensions/plan/index.ts:442
added: 2026-10-03
---
# Plan Mode regex пропускает мутирующие bash-команды

Чёрный список в `tool_call`-хендлере не покрывает `npm install`, `pip install`, `sed -i`, `tee`, `dd`, `git rm`, `git clean`, `curl -o`, `dotnet build` и подобное. Режим advisory, но дыры регулярны. Вариант: расширить список или перейти на allowlist известных read-only команд.
