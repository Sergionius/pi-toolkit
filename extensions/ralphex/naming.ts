// Translation belongs to the planning model, not a character substitution table.
export const PLAN_NAMING_INSTRUCTIONS = `Include exactly one standalone HTML comment near the plan title with the key plan-slug and a task-specific value.
Derive a concise, meaningful English kebab-case slug (at most 80 characters) from the current task's meaning, translating it when the request, title, or source backlog filename is in another language. Do not copy example slugs from instructions, repository files, or unrelated plans; never transliterate or copy a transliterated source filename. Keep the title and body in the user's language. This slug names the saved plan and new execution branch.`;

export function explicitPlanSlug(markdown: string): string | undefined {
  const markers = markdown.match(/<!--\s*plan-slug\b[^\n]*-->/g) ?? [];
  if (!markers.length) return undefined;
  const slug = markers[0].match(/^<!--\s*plan-slug:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->$/)?.[1];
  if (markers.length !== 1 || !slug || slug.length > 80) {
    throw new Error("plan-slug must be one English kebab-case metadata value of at most 80 characters");
  }
  return slug;
}

export function planSlug(markdown: string): string {
  const explicit = explicitPlanSlug(markdown);
  if (explicit) return explicit;
  // Compatibility for existing English drafts; never transliterate localized titles.
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  if (!title || /[^\x20-\x7e]/.test(title)) {
    throw new Error("Add <!-- plan-slug: meaningful-english-name --> to the plan; translate its meaning, do not transliterate");
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
  if (!slug) throw new Error("plan needs a meaningful English plan-slug");
  return slug;
}
