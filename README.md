# SpaceLens

Desktop filesystem storage analysis application. The current shell opens to an Overview placeholder; scanning and analysis are not implemented yet.

Based on the [official electron-vite React + TypeScript template](https://electron-vite.org/guide/).

## Development

Use Node.js 22.12+ (or a newer supported LTS release) and npm.

```sh
npm install
npm run dev
```

If the launching environment sets `ELECTRON_RUN_AS_NODE`, unset it before starting Electron. For example, in PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`.

## Commands

- `npm run dev` — start the renderer development server and Electron with hot reload.
- `npm run typecheck` — check main, preload and renderer TypeScript.
- `npm run lint` — run ESLint.
- `npm run format` — format source and configuration files with Prettier.
- `npm run format:check` — check formatting without modifying files.
- `npm run build` — typecheck and build production output into `out/`.
- `npm start` — preview the production build in Electron after building.
- `npm run build:unpack` — build an unpacked application with electron-builder.

## Structure

- `src/main` — Electron lifecycle and window creation.
- `src/preload` — isolated context bridge exposing only `window.spaceLens.getAppInfo()`.
- `src/renderer` — React application shell, UI primitives and section placeholder pages.
- `src/shared` — shared IPC contracts and channel names.

The sidebar and topbar stay in place while the main content scrolls. At narrower widths, the sidebar becomes an icon rail. Typed React state selects Overview, Explorer, Insights or History without a router. Each launch starts on Overview; page selection is not persisted. Settings remains disabled until implemented.

The typed `getAppInfo()` IPC method remains available through the preload API. Its handler accepts requests only from the application's main renderer frame and takes no arguments.

The renderer has no Node.js access. Context isolation and sandboxing are enabled. Dependencies are locked in `package-lock.json`; use `npm ci` for repeatable installs.

## Design system

Tailwind CSS uses the [official Vite integration](https://tailwindcss.com/docs/installation/using-vite) in the renderer. Semantic color tokens, system fonts, a 4px spacing scale, radii and keyboard focus indicators live in `src/renderer/src/styles/global.css`. The interface uses a single dark theme; prefer semantic utilities such as `bg-surface` and `text-text-secondary` when adding components.

Small, typed `Button`, `Card` and `Badge` primitives live in `src/renderer/src/components/ui`. Import Lucide icons individually from `lucide-react`, hide decorative icons from assistive technology, and give icon-only controls an accessible name. Buttons support native disabled states and respect reduced-motion preferences.
