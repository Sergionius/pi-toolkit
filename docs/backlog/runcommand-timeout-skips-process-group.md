---
worth: yes
priority: p2
where: extensions/ralphex/process.ts:227
added: 2026-10-03
---
# runCommand при таймауте убивает только прямого потомка

В отличие от `runPiWorker`, `runCommand` делает `child.kill("SIGTERM")` без process-group kill: долгий `git push` или `cdt` может оставить живых потомков, переживших таймаут. Исправление: detached-спавн + killpg с эскалацией SIGKILL, как в watchdog `runPiWorker`.
