---
worth: yes
priority: p1
where: extensions/figma-context.ts:95
added: 2026-10-03
---
# figma-кэш «отравляется» невалидным ответом API

`node.json` записывается до проверки, что `nodePayload.nodes[nodeId].document` существует. Если API вернул ответ без запрошенного node, ошибочный payload попадает в кэш, и все последующие вызовы без `force: true` читают его и падают тем же «Figma node not found». Исправление: валидировать node до записи `nodeJsonPath` (или не кэшировать невалидный payload).
