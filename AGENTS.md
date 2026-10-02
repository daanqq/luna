## Development

When starting the dev server, use background mode (`astro` is not on PATH, run it through Bun):

```
bunx astro dev --background
```

Manage the background server with `bunx astro dev stop`, `bunx astro dev status`, and `bunx astro dev logs`.

If the dev server serves stale modules (`504 Outdated Optimize Dep`, `_jsxDEV is not a function`), which happens after dependency changes or a `build` while it runs: stop it, delete `node_modules/.vite`, start it again.

## Validation

- After any change: `bun run check`, `bun run lint`, `bun run build`.
- Headless browsers render WebGL in software (SwiftShader, under 1 fps): they catch shader compile errors and broken layout, but say nothing about GPU performance. Check that live with `?fps=1&gpuload=N&scale=1`.
- The first visit travels to 2026 by itself; to test from the 2001 state, set `localStorage['scene-intro-seen'] = '1'` before the page loads.
- `?era=` pins the scene and disables travel, so the time-travel scale cannot be tested with it.
- A deterministic still frame: reduced motion plus `?era=` and `?time=`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Project

Personal site. Astro 7 pages render static HTML; React 19 is used only for interactive islands (animations). Bun is the package manager and script runner (`bun run dev|check|lint|build`).

- `src/styles/tokens.css`: design tokens (AMOLED palette, Departure Mono, 11px type scale, 22px line rhythm). Override tokens inside a page root, not globally.
- `src/layouts/Base.astro`: HTML shell; `page` prop sets `body[data-page]` for page-scoped token overrides.
- `src/lib/ticker.ts`: the single shared requestAnimationFrame loop. All animations subscribe here.
- `src/lib/reduced-motion.ts`, `src/lib/dither.ts`: reduced-motion check/hook, Bayer dithering matrix.
- `src/data/profile.ts`: site content (name, handle, role, description, links).
- `src/pages/index.astro`: the only page; renders the scene from `src/scene/` (WebGL2 moon, FFT sea and aurora, 2001 → 2026 time-travel scale; code and CSS still call the pixel look `1997`). Its styles live in `src/scene/scene.css`, scoped by `[data-page='home']`; classes and data attributes use the `scene-` prefix.
- `public/moon/`: moon textures used by the scene.

Rules:

- Keep the bundle small: no new dependencies without a clear reason. `@chenglou/pretext` is available for text layout.
- Functions cannot be passed as props from `.astro` into islands; wrap a program in its own React component.
- Real content stays in HTML; canvases are decorative (`aria-hidden`).
- Every animation pauses off-screen and respects `prefers-reduced-motion`.
- Departure Mono is crisp only at multiples of 11px.
- Shader compile time on Edge (ANGLE / Direct3D 11) is the main constraint of `src/scene/shaders.ts`: do not grow the per-pass programs or unroll loops. The 2026 programs compile asynchronously after the first 2001 frame.
- The glyph grid has about 64k cells at 4K: work that depends only on the row or the column is computed once in `build()`, not per cell per frame.
- File names must not differ only in letter case (like `Aurora.tsx` and `aurora.ts`): on Windows and macOS an extensionless import then resolves to the wrong file.
- Document new debug query parameters in the README table.
