# SpaceLens

SpaceLens analyzes the logical sizes of files in a selected folder. **Scan Folder** opens the native directory picker. A worker reads the selected folder and reports progress, and you can cancel an active scan.

- **Overview** shows the active scan and the latest published summary. The storage device cards use example drives and decimal GB (1 GB = 1,000,000,000 bytes).
- **Explorer** browses the published directory tree, file details, contents pages, and Treemap.
- **Insights** shows file categories, extensions, size distribution, the largest files and directories, and storage observations. Extensions displays 20 groups per page, and ranked entries can open directly in Explorer.

## Windows x64 installation

Run `spacelens-0.1.0-setup.exe` and launch SpaceLens from the Start menu or desktop shortcut. The one-click NSIS installer installs for the current Windows user. A new installation typically uses `%LOCALAPPDATA%\Programs\spacelens`. The installer is unsigned, so Windows may display a security warning.

SpaceLens stores its SQLite database in `%APPDATA%\spacelens\scans.sqlite` on Windows. The normal uninstall configuration preserves the profile and scan database.

To build the installer from this repository after `npm ci`:

```sh
npm run build
npm exec -- electron-builder --win --x64 --config.electronDist=node_modules/electron/dist --publish never
```

The installer is generated in `dist/`. The installed app uses the bundled runtime and production resources.

## Scan storage

SpaceLens streams scanner batches into `scans.sqlite` in Electron's `userData` directory. Overview restores the latest published scan after startup recovery and displays its folder, completion time, logical size, file and directory counts, and filesystem errors. The Folder scan panel starts idle. Recent Scans displays an empty state until the first successful scan.

At startup, Electron's single-instance lock protects the application profile while the Storage Worker checks publication sequences and foreign keys, validates the latest completed scan, and removes interrupted scans in a transaction. New scans wait for recovery. If recovery fails, a write outcome is unknown, or a building scan cannot be discarded, SpaceLens blocks further scans for that session. Restarting runs recovery against the committed SQLite state.

The Storage Worker upgrades schema v1 databases to v2 in one transaction. It preserves the saved scan and its entries and discards interrupted scans as part of the upgrade. Phase 4 builds cannot open schema v2. Downgrading requires a copy of the database from before the upgrade.

Storage requests have a 10-second deadline. On normal shutdown Main waits for scanner and startup work to settle, then gives the Worker two seconds to close. If the Worker must be terminated, the client waits up to another two seconds for it to exit.

SQLite uses its default `DELETE` rollback journal. Recovery and cancellation free pages from interrupted or discarded scans for future writes. A rollback journal may be present during a write or after an interruption. SQLite handles journal recovery when the database is reopened.

Overview, Explorer, and Insights use the latest completed scan. After publication is confirmed, the views refresh for the new scan. SpaceLens retains each completed snapshot and allows at most one building scan. Completed scans accumulate without a limit until configurable retention and automatic pruning arrive in Task 5.6. Known logical sizes can be partial when some items are unreadable. The UI reports scan errors and incomplete coverage.

Directory pages contain at most 100 direct children, sorted by name then ID in UTF-16 order. Explorer and Insights references expire when a newer scan becomes Latest. Treemap reads the latest completed scan, including after restart. It ranks up to 100 direct children by known size and groups the remaining entries into Other. It uses logical file sizes and the scanner's stored directory totals.

Main serializes reads and scanner writes through one Storage Worker. Scanner writes take priority over queued reads. Up to 16 reads may wait for a turn, each with a 10-second queue deadline. Document changes and shutdown drop queued snapshot reads. An active SQLite query can delay the next write. Cold analytics and targeting a file in a wide or deeply nested directory can take noticeable time on large scans. Cancellation remains available through traversal and batch persistence and closes when the final publication request is sent.

Scan history and comparisons, duplicate detection, file cleanup, and background monitoring are deferred beyond Phase 4.

Based on the [official electron-vite React + TypeScript template](https://electron-vite.org/guide/).

## Development

Use Node.js 22.22.2+, 24.15+ or a newer supported LTS release, and npm. These minimums also cover the jsdom test environment.

```sh
npm install
npm run dev
```

If the launching environment sets `ELECTRON_RUN_AS_NODE`, unset it before starting Electron. For example, in PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`.

### React Developer Tools

Install React Developer Tools in Chrome, then set `REACT_DEVTOOLS_PATH` to the absolute path of its unpacked extension directory (the version directory containing `manifest.json`). Use `chrome://version` to find your profile path and `chrome://extensions` to find the extension ID; the directory is under `<profile path>/Extensions/<extension ID>/<version>`.

Set it in the project-root `.env` file, replacing the placeholder with your extension directory. Use forward slashes on Windows:

```dotenv
REACT_DEVTOOLS_PATH="C:/path/to/react-devtools/version"
```

Then run `npm run dev`. Restart the development server after changing `.env`. The development config passes this variable to Electron without exposing it to renderer code. A shell environment variable takes precedence over `.env`. Local `.env` files are ignored by Git and excluded from packaged applications.

Press F12 in SpaceLens to open Electron DevTools. Check the **Components** and **Profiler** tabs (possibly under the `»` overflow menu); Components should show the React tree, and Profiler can record interactions such as switching sections.

If Components initially reports that React has not loaded, reload the application window once with Ctrl+R (Cmd+R on macOS) while DevTools is open.

The extension loads through Electron's `session.defaultSession.extensions.loadExtension` API before the renderer starts, only when `NODE_ENV=development` and the app is not packaged. Packaged builds never load it, even if the variable is set. An unset variable skips loading; an invalid or missing extension logs a warning and startup continues. No additional dependencies are needed, and Electron's context isolation, sandboxing and Node.js integration settings remain unchanged.

## Commands

- `npm run dev` — start the renderer development server and Electron with hot reload.
- `npm run typecheck` — check main, preload, renderer, test and test-configuration TypeScript.
- `npm run lint` — run ESLint.
- `npm test` — run all Vitest utility and React component tests once.
- `npm run test:watch` — run Vitest in watch mode during development.
- `npm run format` — format source and configuration files with Prettier.
- `npm run format:check` — check formatting without modifying files.
- `npm run build` — typecheck and build production output into `out/`.
- `npm start` — preview the production build in Electron after building.
- `npm run build:unpack` — build an unpacked application with electron-builder.

Tests live in `tests/` as `.test.ts` and `.test.tsx` files. `vitest.config.mts` uses the existing React plugin and jsdom; `tests/setup.ts` adds jest-dom matchers and cleans up rendered components after each test. Test workers use UTC so completion-date assertions are independent of the computer's timezone; the application still displays local times. Scan fixtures stay inside test files and never read local storage or scan history.

## Structure

- `src/main` — Electron lifecycle, scanner worker, scan session management, and SQLite storage and recovery.
- `src/preload` — isolated, typed context bridge for application information, authorized scanning and bounded snapshot retrieval.
- `src/renderer` — React application shell, UI primitives, Overview, Explorer, and Insights.
- `src/shared` — shared IPC contracts and channel names.

The sidebar and topbar stay in place while the main content scrolls. At narrower widths, the sidebar becomes an icon rail. Typed React state selects Overview, Explorer, Insights or History without a router. Each launch starts on Overview; page selection is not persisted. Settings remains disabled until implemented.

The typed `getAppInfo()` IPC method remains available through the preload API. Its handler accepts requests only from the application's main renderer frame and takes no arguments.

The renderer has no Node.js access. Context isolation and sandboxing are enabled. Dependencies are locked in `package-lock.json`; use `npm ci` for repeatable installs.

## Design system

Tailwind CSS uses the [official Vite integration](https://tailwindcss.com/docs/installation/using-vite) in the renderer. Semantic color tokens, system fonts, a 4px spacing scale, radii and keyboard focus indicators live in `src/renderer/src/styles/global.css`. The interface uses a single dark theme; prefer semantic utilities such as `bg-surface` and `text-text-secondary` when adding components.

Small, typed `Button`, `Card` and `Badge` primitives live in `src/renderer/src/components/ui`. Import Lucide icons individually from `lucide-react`, hide decorative icons from assistive technology, and give icon-only controls an accessible name. Buttons support native disabled states and respect reduced-motion preferences.
