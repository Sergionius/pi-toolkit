import { readFile, writeFile } from "node:fs/promises";

export type PlanTask = {
  number: number;
  title: string;
  start: number;
  end: number;
  unchecked: number;
};

const TASK_HEADER = /^###\s+(?:Task|Iteration)\s+(\d+):\s*(.+?)\s*$/;
const BASE_COMMENT = /^<!--\s*ralphex-base:\s*([0-9a-f]{7,40})\s*-->\s*$/m;

export function parseTasks(markdown: string): PlanTask[] {
  const lines = markdown.split("\n");
  const tasks: PlanTask[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(TASK_HEADER);
    if (!match) continue;
    if (tasks.length) tasks[tasks.length - 1].end = index;
    tasks.push({
      number: Number(match[1]),
      title: match[2].trim(),
      start: index,
      end: lines.length,
      unchecked: 0,
    });
  }
  for (const task of tasks) {
    task.unchecked = lines.slice(task.start + 1, task.end).filter((line) => /^\s*-\s*\[\s\]/.test(line)).length;
  }
  return tasks;
}

export function firstIncompleteTask(markdown: string): PlanTask | undefined {
  return parseTasks(markdown).find((task) => task.unchecked > 0);
}

export function baseCommit(markdown: string): string | undefined {
  return markdown.match(BASE_COMMENT)?.[1];
}

export function ensureBaseCommit(markdown: string, commit: string): string {
  if (baseCommit(markdown)) return markdown;
  return `<!-- ralphex-base: ${commit} -->\n\n${markdown}`;
}

export function appendExecutionNote(markdown: string, note: string): string {
  const clean = note.replace(/\s+/g, " ").trim();
  const line = `- ${clean}`;
  const heading = "## Execution Notes";
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex < 0) return `${markdown.trimEnd()}\n\n${heading}\n\n${line}\n`;

  const afterHeading = headingIndex + heading.length;
  const nextHeading = markdown.slice(afterHeading).search(/\n##\s+/);
  const insertAt = nextHeading < 0 ? markdown.length : afterHeading + nextHeading;
  return `${markdown.slice(0, insertAt).trimEnd()}\n${line}\n\n${markdown.slice(insertAt).trimStart()}`;
}

export async function readPlan(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writePlan(path: string, markdown: string): Promise<void> {
  await writeFile(path, markdown, "utf8");
}
