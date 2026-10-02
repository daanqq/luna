# luna

Personal site of Danila Andreev.

One full-screen scene: a giant Moon over an FFT sea under an aurora, with a time-travel scale from 2001 (dithered pixels, ASCII text curtain) to 2026 (WebGL2 shading) through five stages in between. The content itself stays in plain HTML; the canvas is decorative.

## Stack

- [Astro 7](https://astro.build) renders static HTML.
- React 19 only for the canvas island.
- Raw WebGL2 for the scene, with a Canvas2D fallback.
- [Bun](https://bun.sh) as the package manager and script runner.

## Commands

| Command         | Action                                     |
| :-------------- | :----------------------------------------- |
| `bun install`   | Install dependencies                       |
| `bun run dev`   | Start the dev server at `localhost:4321`   |
| `bun run check` | Type-check (`astro check`)                 |
| `bun run lint`  | Lint (`oxlint`)                            |
| `bun run build` | Build the static site into `./dist/`       |
| `bun run preview` | Preview the production build             |

## Structure

```text
public/
  fonts/            Departure Mono, font licenses
  moon/             Moon textures
src/
  data/profile.ts   name, handle, role, links
  layouts/          HTML shell
  lib/              shared rAF ticker, reduced motion, dithering
  pages/index.astro the only page
  scene/            WebGL2 scene, aurora, FFT ocean, era switch, styles
  styles/           design tokens and base styles
```

## Debug query parameters

| Parameter      | Effect                                        |
| :------------- | :-------------------------------------------- |
| `?fps=1`       | Show the FPS counter                          |
| `?era=0..1`    | Pin the era: `0` is 2001, `1` is 2026         |
| `?scale=N`     | Pin the render scale (`0.5..1`)               |
| `?gpuload=N`   | Repeat every GPU pass `N` times (`1..8`) to stand in for a slower GPU |
| `?curve=N`     | Horizon drop at the screen edges in 2026, % of the width (`0..5`, default `0.25`) |
| `?time=N`      | Still frame moment with reduced motion        |
| `?nofft=1`     | Use the sine sea instead of the FFT ocean     |
| `?fftlog=1`    | Log FFT timings to the console                |
| `?meteor=1`    | Meteors every few seconds                     |

## Credits

- Moon: NASA SVS 4720 "CGI Moon Kit", LRO colour map (public domain).
- 2001 text curtain: Apollo 11 guidance computer source, MIT Instrumentation Laboratory, 1969, via [chrislgarry/Apollo-11](https://github.com/chrislgarry/Apollo-11) (public domain).
- Fonts: [Departure Mono](https://departuremono.com), see `public/fonts/DepartureMono-LICENSE.txt`; [Space Mono](https://github.com/googlefonts/spacemono) (SIL Open Font License 1.1, bundled from `@fontsource/space-mono`), see `public/fonts/SpaceMono-LICENSE.txt`.
