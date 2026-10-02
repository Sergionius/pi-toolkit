import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A small interactive decision tool for the backlog skill, independent of Plan Mode. */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "backlog_choice",
    label: "Backlog choice",
    description: "Ask the user to select one of 2–4 explicit backlog actions. Put the recommended action first. A cancelled or unavailable menu does not authorize any action.",
    exposure: "model-only",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 4 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { question, options } = params;
      if (!question.trim() || options.some((option) => !option.trim()) || new Set(options).size !== options.length) {
        return { content: [{ type: "text", text: "Backlog question and option labels must be non-empty; option labels must be unique. No action authorized." }], details: undefined, isError: true };
      }
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "Interactive UI unavailable. No backlog action authorized." }], details: undefined, isError: true };
      }
      const selected = await ctx.ui.select(question, options);
      if (!selected || !options.includes(selected)) {
        return { content: [{ type: "text", text: "Backlog selection cancelled or invalid. No action authorized." }], details: undefined, isError: true };
      }
      return { content: [{ type: "text", text: `Selected: ${selected}` }], details: { selected } };
    },
  });
}
