---
name: figma-to-css
description: Use when the user provides a Figma design URL and asks for CSS, layout, screen implementation, assets, visual comparison, or frontend code from a Figma frame. Requires the figma_get_screen_context tool.
---

# Figma to CSS

Use this workflow whenever the user asks to convert a Figma screen/frame into CSS or implementation details.

## Workflow

1. Call `figma_get_screen_context` with the Figma URL.
   - Default `scale: 2` is usually enough.
   - Use `force: true` if the user says the design changed or cache may be stale.
2. Read the returned `screenshotPath` with the `read` tool as an image.
   - The screenshot is the visual source of truth.
   - Use the generated CSS and `node.json` as structured hints, not as final truth.
3. Inspect the generated `screen.css` and `summary.md` paths if needed.
4. Produce production CSS:
   - Prefer semantic classes over Figma layer names.
   - Remove noisy Figma-only properties unless they matter: repeated `order`, `flex: none`, `margin: 0 auto`, unnecessary fixed child widths.
   - Keep exact values that affect visual fidelity: sizes, spacing, radius, typography, colors, shadows, image positions.
   - Mention any assumptions about assets, responsive behavior, or missing fonts.
5. If the requested output is implementation-ready code, include a minimal HTML/JSX structure that matches the CSS classes.

## Output style

Be concise. Start with the key frame size and asset paths, then provide CSS. If there is a likely mismatch between API frame size and the user's selected Figma CSS/dev-mode output, call it out and ask whether they want that specific breakpoint or selected nested frame.
