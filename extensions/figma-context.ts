import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "figma_get_screen_context";
const FIGMA_API = "https://api.figma.com/v1";

type Rgba = { r: number; g: number; b: number; a?: number };
type FigmaNode = Record<string, any> & {
	id?: string;
	name?: string;
	type?: string;
	children?: FigmaNode[];
	absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
};

interface FigmaDetails {
	fileKey: string;
	nodeId: string;
	frameName?: string;
	width?: number;
	height?: number;
	cacheDir: string;
	nodeJsonPath: string;
	screenshotPath?: string;
	cssPath: string;
	summaryPath: string;
	truncated?: boolean;
}

const Params = Type.Object({
	url: Type.String({ description: "Figma design/file URL containing file key and node-id" }),
	scale: Type.Optional(Type.Number({ description: "PNG export scale. Default: 2" })),
	format: Type.Optional(Type.String({ description: "Image format: png, jpg, svg, or pdf. Default: png" })),
	force: Type.Optional(Type.Boolean({ description: "Ignore cached files and fetch from Figma again" })),
});

export default function figmaContext(pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		if (!extractFigmaUrls(event.text).length) return { action: "continue" };
		if (event.text.includes("[Automatic Figma context workflow]")) return { action: "continue" };

		return {
			action: "transform",
			text: `${event.text.trim()}\n\n[Automatic Figma context workflow]\nThis task contains a Figma URL. Before implementing or answering, call figma_get_screen_context for each Figma URL. Then read the returned screenshotPath with the read tool as an image. Use the screenshot as the source of truth for pixel-perfect visual fidelity, and use node.json/screen.css/summary.md as structured implementation context.`,
		};
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Figma Context",
		description:
			"Fetch a Figma frame by URL, export a screenshot, save node JSON, and generate implementation-oriented CSS/layout context. Requires FIGMA_TOKEN in the environment.",
		promptSnippet: "Fetch screenshot + node JSON + CSS/layout context from a Figma frame URL",
		promptGuidelines: [
			"Use figma_get_screen_context when the user provides a Figma URL and asks for CSS, layout, assets, or screen implementation details.",
			"After figma_get_screen_context returns a screenshotPath, use the read tool on that image when visual fidelity matters.",
			"Treat generated Figma CSS as a starting point; simplify noisy auto-layout properties before giving production CSS.",
		],
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const token = process.env.FIGMA_TOKEN;
			if (!token) {
				throw new Error("FIGMA_TOKEN is not set in the pi process environment. Export it before starting pi.");
			}

			const parsed = parseFigmaUrl(params.url);
			const scale = params.scale ?? 2;
			const format = normalizeFormat(params.format);
			const safeNode = parsed.nodeId.replace(/:/g, "-");
			const cacheDir = resolve(ctx.cwd, ".pi", "figma-cache", parsed.fileKey, safeNode);
			const nodeJsonPath = join(cacheDir, "node.json");
			const imagePath = join(cacheDir, `screenshot.${format}`);
			const cssPath = join(cacheDir, "screen.css");
			const summaryPath = join(cacheDir, "summary.md");

			await mkdir(cacheDir, { recursive: true });

			onUpdate?.({ content: [{ type: "text", text: "Fetching Figma node…" }] });
			const nodePayload =
				!params.force && existsSync(nodeJsonPath)
					? JSON.parse(await readFile(nodeJsonPath, "utf8"))
					: await figmaJson(`${FIGMA_API}/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`, token, signal);
			await writeFile(nodeJsonPath, JSON.stringify(nodePayload, null, 2), "utf8");

			const document = nodePayload?.nodes?.[parsed.nodeId]?.document as FigmaNode | undefined;
			if (!document) throw new Error(`Figma node not found: ${parsed.nodeId}`);

			onUpdate?.({ content: [{ type: "text", text: "Exporting screenshot…" }] });
			let screenshotPath: string | undefined;
			if (params.force || !existsSync(imagePath)) {
				const imagePayload = await figmaJson(
					`${FIGMA_API}/images/${parsed.fileKey}?ids=${encodeURIComponent(parsed.nodeId)}&format=${format}&scale=${scale}`,
					token,
					signal,
				);
				const imageUrl = imagePayload?.images?.[parsed.nodeId];
				if (imageUrl) {
					const image = await fetch(imageUrl, { signal });
					if (!image.ok) throw new Error(`Failed to download Figma image: ${image.status} ${image.statusText}`);
					await writeFile(imagePath, Buffer.from(await image.arrayBuffer()));
					screenshotPath = imagePath;
				}
			} else {
				screenshotPath = imagePath;
			}

			onUpdate?.({ content: [{ type: "text", text: "Generating CSS/layout summary…" }] });
			const css = generateCss(document);
			const summary = generateSummary(document, {
				fileKey: parsed.fileKey,
				nodeId: parsed.nodeId,
				nodeJsonPath,
				screenshotPath,
				cssPath,
			});
			await writeFile(cssPath, css, "utf8");
			await writeFile(summaryPath, summary, "utf8");

			const fullText = `${summary}\n\n## Generated CSS\n\n\`\`\`css\n${css}\n\`\`\`\n`;
			const truncation = truncateHead(fullText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let text = truncation.content;
			if (truncation.truncated) {
				text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				text += ` Full files saved in ${cacheDir}]`;
			}

			const box = document.absoluteBoundingBox;
			return {
				content: [{ type: "text", text }],
				details: {
					fileKey: parsed.fileKey,
					nodeId: parsed.nodeId,
					frameName: document.name,
					width: box?.width,
					height: box?.height,
					cacheDir,
					nodeJsonPath,
					screenshotPath,
					cssPath,
					summaryPath,
					truncated: truncation.truncated,
				} satisfies FigmaDetails,
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", args.url ?? ""), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching Figma context…"), 0, 0);
			const d = result.details as FigmaDetails | undefined;
			if (!d) return new Text(theme.fg("error", "No Figma details"), 0, 0);
			let text = theme.fg("success", `✓ ${d.frameName ?? d.nodeId}`);
			if (d.width && d.height) text += theme.fg("muted", ` ${d.width}×${d.height}`);
			text += `\n${theme.fg("dim", `CSS: ${d.cssPath}`)}`;
			if (d.screenshotPath) text += `\n${theme.fg("dim", `Screenshot: ${d.screenshotPath}`)}`;
			if (expanded) text += `\n${theme.fg("dim", `Node JSON: ${d.nodeJsonPath}`)}`;
			return new Text(text, 0, 0);
		},
	});
}

function extractFigmaUrls(text: string): string[] {
	return Array.from(text.matchAll(/https?:\/\/(?:www\.)?figma\.com\/[^\s)\]}>'"]+/gi), (match) => match[0]);
}

function parseFigmaUrl(input: string): { fileKey: string; nodeId: string } {
	const url = new URL(input);
	const parts = url.pathname.split("/").filter(Boolean);
	const fileKey = parts[1];
	const nodeParam = url.searchParams.get("node-id");
	if (!fileKey) throw new Error("Could not parse Figma file key from URL");
	if (!nodeParam) throw new Error("Figma URL must include node-id");
	return { fileKey, nodeId: nodeParam.replace(/-/g, ":") };
}

function normalizeFormat(format?: string): "png" | "jpg" | "svg" | "pdf" {
	const value = (format ?? "png").toLowerCase();
	if (["png", "jpg", "svg", "pdf"].includes(value)) return value as any;
	throw new Error(`Unsupported Figma image format: ${format}`);
}

async function figmaJson(url: string, token: string, signal?: AbortSignal) {
	const response = await fetch(url, { headers: { "X-Figma-Token": token }, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Figma API failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
	}
	return response.json();
}

function generateSummary(root: FigmaNode, paths: Record<string, string | undefined>): string {
	const box = root.absoluteBoundingBox;
	const lines = [
		"# Figma screen context",
		"",
		`- Frame: ${root.name ?? "Untitled"}`,
		`- Type: ${root.type ?? "unknown"}`,
		box ? `- Size: ${round(box.width)}×${round(box.height)}` : undefined,
		`- Figma node: ${paths.fileKey} / ${paths.nodeId}`,
		`- Screenshot: ${paths.screenshotPath ?? "not exported"}`,
		`- Node JSON: ${paths.nodeJsonPath}`,
		`- CSS: ${paths.cssPath}`,
		"",
		"## Important implementation notes",
		"",
		"- The screenshot is the source of truth for visual fidelity; read it as an image before finalizing CSS.",
		"- The generated CSS is intentionally semantic and cleaned up; it avoids most Figma-only `order`, `flex-grow`, and `margin: 0 auto` noise.",
		"- If exact assets are needed, inspect `node.json` for IMAGE fills and export those nodes separately.",
		"",
		"## Node outline",
		"",
		...outline(root).map((line) => `- ${line}`),
	].filter(Boolean);
	return lines.join("\n");
}

function outline(node: FigmaNode, depth = 0): string[] {
	const box = node.absoluteBoundingBox;
	const prefix = "  ".repeat(depth);
	const bits = [`${prefix}${node.name ?? "Untitled"} [${node.type ?? "?"}]`];
	if (box) bits.push(`${round(box.width)}×${round(box.height)}`);
	if (node.layoutMode) bits.push(`layout=${node.layoutMode}`);
	if (node.itemSpacing !== undefined) bits.push(`gap=${round(node.itemSpacing)}`);
	const result = [bits.join(" ")];
	for (const child of node.children ?? []) {
		if (depth < 3) result.push(...outline(child, depth + 1));
	}
	return result;
}

function generateCss(root: FigmaNode): string {
	const rules: string[] = [];
	const tokens = collectTokens(root);
	rules.push(`:root {\n${tokens.map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n}`);
	rules.push("");
	walkCss(root, rules, "figma-screen", true);
	return rules.join("\n\n");
}

function walkCss(node: FigmaNode, rules: string[], className: string, isRoot = false) {
	const selector = `.${className}`;
	const lines: string[] = [];
	const box = node.absoluteBoundingBox;
	if (isRoot) lines.push("position: relative;", "isolation: isolate;", "overflow: hidden;", "box-sizing: border-box;");
	if (box) {
		lines.push(`width: ${px(box.width)};`, `height: ${px(box.height)};`);
	}
	appendLayout(lines, node);
	appendPaint(lines, node);
	appendText(lines, node);
	if (node.type === "RECTANGLE" && hasImageFill(node)) lines.push("object-fit: cover;");
	if (lines.length) rules.push(`${selector} {\n${lines.map((l) => `  ${l}`).join("\n")}\n}`);

	const used = new Map<string, number>();
	for (const child of node.children ?? []) {
		const base = semanticClass(child);
		const count = (used.get(base) ?? 0) + 1;
		used.set(base, count);
		walkCss(child, rules, `${className}__${base}${count > 1 ? `-${count}` : ""}`);
	}
}

function appendLayout(lines: string[], node: FigmaNode) {
	if (!node.layoutMode) return;
	lines.push("display: flex;");
	lines.push(`flex-direction: ${node.layoutMode === "HORIZONTAL" ? "row" : "column"};`);
	if (node.primaryAxisAlignItems) lines.push(`justify-content: ${figmaAlign(node.primaryAxisAlignItems)};`);
	if (node.counterAxisAlignItems) lines.push(`align-items: ${figmaAlign(node.counterAxisAlignItems)};`);
	const p = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
	if (p.some((v) => typeof v === "number" && v !== 0)) lines.push(`padding: ${p.map((v) => px(v ?? 0)).join(" ")};`);
	if (typeof node.itemSpacing === "number" && node.itemSpacing !== 0) lines.push(`gap: ${px(node.itemSpacing)};`);
	lines.push("box-sizing: border-box;");
}

function appendPaint(lines: string[], node: FigmaNode) {
	const fill = firstSolid(node.fills);
	if (fill) lines.push(`background: ${rgba(fill)};`);
	const stroke = firstSolid(node.strokes);
	if (stroke) lines.push(`border: ${px(node.strokeWeight ?? 1)} solid ${rgba(stroke)};`);
	const radius = node.cornerRadius ?? maxCorner(node.rectangleCornerRadii);
	if (typeof radius === "number" && radius > 0) lines.push(`border-radius: ${px(radius)};`);
	const shadow = shadowCss(node.effects);
	if (shadow) lines.push(`box-shadow: ${shadow};`);
}

function appendText(lines: string[], node: FigmaNode) {
	if (node.type !== "TEXT" || !node.style) return;
	const s = node.style;
	if (s.fontFamily) lines.push(`font-family: "${s.fontFamily}", system-ui, sans-serif;`);
	if (s.fontWeight) lines.push(`font-weight: ${s.fontWeight};`);
	if (s.fontSize) lines.push(`font-size: ${px(s.fontSize)};`);
	if (s.lineHeightPx) lines.push(`line-height: ${px(s.lineHeightPx)};`);
	const fill = firstSolid(node.fills);
	if (fill) lines.push(`color: ${rgba(fill)};`);
	if (s.textAlignHorizontal) lines.push(`text-align: ${String(s.textAlignHorizontal).toLowerCase()};`);
	lines.push("font-feature-settings: 'pnum' on, 'lnum' on;");
}

function collectTokens(root: FigmaNode): Array<[string, string]> {
	const colors = new Map<string, string>();
	const fonts = new Map<string, string>();
	visit(root, (node) => {
		for (const paint of [...(node.fills ?? []), ...(node.strokes ?? [])]) {
			if (paint?.visible === false || paint?.type !== "SOLID") continue;
			const value = rgba(paint.color);
			colors.set(value, value);
		}
		if (node.style?.fontFamily) fonts.set(node.style.fontFamily, `"${node.style.fontFamily}", system-ui, sans-serif`);
	});
	const entries: Array<[string, string]> = [];
	let i = 1;
	for (const value of colors.values()) entries.push([`figma-color-${i++}`, value]);
	i = 1;
	for (const value of fonts.values()) entries.push([`figma-font-${i++}`, value]);
	return entries.length ? entries : [["figma-font-1", "system-ui, sans-serif"]];
}

function visit(node: FigmaNode, fn: (node: FigmaNode) => void) {
	fn(node);
	for (const child of node.children ?? []) visit(child, fn);
}

function semanticClass(node: FigmaNode): string {
	const raw = (node.name || node.type || "node").toLowerCase();
	const translit = raw
		.replace(/добро пожаловать/g, "title")
		.replace(/логотип|logo/g, "logo")
		.replace(/button/g, "button")
		.replace(/item/g, "chip")
		.replace(/text/g, "text")
		.replace(/image/g, "image")
		.replace(/frame/g, "frame");
	return translit.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "node";
}

function firstSolid(paints: any[] | undefined): Rgba | undefined {
	const paint = paints?.find((p) => p?.visible !== false && p?.type === "SOLID" && p?.color);
	return paint?.color;
}

function hasImageFill(node: FigmaNode): boolean {
	return (node.fills ?? []).some((p: any) => p?.visible !== false && p?.type === "IMAGE");
}

function rgba(c: Rgba): string {
	const r = Math.round(c.r * 255);
	const g = Math.round(c.g * 255);
	const b = Math.round(c.b * 255);
	const a = c.a ?? 1;
	if (a < 1) return `rgba(${r}, ${g}, ${b}, ${round(a, 3)})`;
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hex(n: number): string {
	return n.toString(16).padStart(2, "0");
}

function shadowCss(effects: any[] | undefined): string | undefined {
	const shadows = (effects ?? [])
		.filter((e) => e?.visible !== false && ["DROP_SHADOW", "INNER_SHADOW"].includes(e?.type))
		.map((e) => {
			const inset = e.type === "INNER_SHADOW" ? "inset " : "";
			return `${inset}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius ?? 0)} ${rgba(e.color ?? { r: 0, g: 0, b: 0, a: 0.2 })}`;
		});
	return shadows.length ? shadows.join(", ") : undefined;
}

function figmaAlign(value: string): string {
	switch (value) {
		case "MIN":
			return "flex-start";
		case "MAX":
			return "flex-end";
		case "CENTER":
			return "center";
		case "SPACE_BETWEEN":
			return "space-between";
		default:
			return "flex-start";
	}
}

function maxCorner(value: number[] | undefined): number | undefined {
	return Array.isArray(value) ? Math.max(...value) : undefined;
}

function px(value: number): string {
	return `${round(value)}px`;
}

function round(value: number, digits = 2): number {
	return Number(value.toFixed(digits));
}
