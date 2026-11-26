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

SpaceLens streams scanner batches into `scans.sqlite` in Electron's `userData` directory. Overview's Recent Scans loads up to five retained completed snapshots across all roots, newest publication first. Each row shows the folder, completion time, logical size, file and directory counts, scan duration, and incomplete coverage when some items could not be scanned. The Folder scan panel starts idle and retains its action to open the latest published scan.

At startup, Electron's single-instance lock protects the application profile while the Storage Worker checks publication sequences and foreign keys, validates the latest completed scan, and removes interrupted scans in a transaction. New scans wait for recovery. If recovery fails, a write outcome is unknown, or a building scan cannot be discarded, SpaceLens blocks further scans for that session. Restarting runs recovery against the committed SQLite state.

The Storage Worker upgrades schema v1 databases to v2 in one transaction. It preserves the saved scan and its entries and discards interrupted scans as part of the upgrade. Phase 4 builds cannot open schema v2. Downgrading requires a copy of the database from before the upgrade.

Storage requests have a 10-second deadline. On normal shutdown Main waits for scanner and startup work to settle, then gives the Worker two seconds to close. If the Worker must be terminated, the client waits up to another two seconds for it to exit.

SQLite uses its default `DELETE` rollback journal. Recovery and cancellation free pages from interrupted or discarded scans for future writes. A rollback journal may be present during a write or after an interruption. SQLite handles journal recovery when the database is reopened.

Explorer and Insights follow Latest by default. Each Recent Scans row opens that exact snapshot in either view, including the row marked Latest. Both views show the selected root, completion time, selection mode, and whether the snapshot is historical. Their Follow Latest actions return explicit views to the current publication. SpaceLens retains completed snapshots under the history retention policy and allows at most one building scan. Known logical sizes can be partial when some items are unreadable. The UI reports scan errors and incomplete coverage.

Directory pages contain at most 100 direct children, sorted by name then ID in UTF-16 order. Explorer and Insights queries use their own adopted scan IDs. Treemap ranks up to 100 direct children by known size and groups the remaining entries into Other. It uses logical file sizes and the scanner's stored directory totals.

Main serializes reads and scanner writes through one Storage Worker. Scanner writes take priority over queued reads. Up to 16 reads may wait for a turn, each with a 10-second queue deadline. Document changes and shutdown drop queued snapshot reads. An active SQLite query can delay the next write. Cold analytics and targeting a file in a wide or deeply nested directory can take noticeable time on large scans. Cancellation remains available through traversal and batch persistence and closes when the final publication request is sent.

The History API reads completed scan metadata in pages of 20 by default, with at most 100 scans per request. Root filters match stored paths case-sensitively, with literal substring search available. Offset-based pages reflect the current history on each read. Overview refreshes its first five rows after committed publication, deletion, or pruning, using the history revision on the scanner-state channel. A listed row can expire before it is opened. Selecting a row acquires protection through the destination view.

The History deletion API removes one completed snapshot and its stored entries in a SQLite transaction. Deleting Latest selects the next publication by sequence, or clears Latest when history is empty. Confirmed publications, manual deletions, and automatic pruning advance a history revision on the scanner-state channel. The deletion queue admits one request at a time. Queued scanner writes take priority, and an active cascade can delay the next batch because SQLite executes it synchronously.

Main owns process-local protection. ID-based Explorer and Insights requests hold their snapshot from queue admission until the worker operation settles. A dispatched request keeps protection after renderer navigation or timeout until the worker replies or exits. Latest discovery reads the current snapshot through the serialized worker. History metadata reads use their own read transactions.

Explorer and Insights each have one Main-owned selection slot per authorized renderer document. A slot holds its adopted snapshot and at most one prepared replacement. Main validates that the candidate is a retained completed scan before issuing an adoption ticket. Failed, superseded, and unadopted candidates release their provisional lease. Adoption releases the previous lease after the replacement is protected. Navigating away releases view leases, and a document replacement, renderer exit, or application shutdown clears its slots.

Ordinary sidebar entry and Overview’s Explorer action start in Follow Latest. Clicking the sidebar for the current Follow Latest view preserves its workspace. Clicking it for an explicit selection resets that view to Follow Latest. A snapshot-specific target carries its own mode and optional Explorer entry. The destination opens immediately and waits for adoption before reading, and a handoff keeps the source lease until the destination adopts or the transition is abandoned. Ranked links from explicit Insights open Explorer on the originating scan and entry. Links from Follow Latest keep their existing scan-changed notice if a new publication supersedes the target. Explicit selections keep their scan ID across publications while active. Leaving the view clears its selection. Active selections and leases are rebuilt per launch.

The Storage Worker validates retained trees on demand using the publication checks for the root, reachability, counts, known logical bytes, and directory aggregates. Explorer and Insights share a worker-local cache of up to eight successful validations. Committed deletion invalidates the affected result. Startup validates the Latest tree and checks dangling scan references and parent relationships in Latest and abandoned builds. Historical parent and tree faults are reported when that snapshot is opened. Main validates under a provisional lease before adoption. Explorer returns the selected root on adoption. Explorer reads and Insights analytics require the matching adopted view and retain their own request protection.

The analytics cache holds aggregates for one scan, with a 512 KiB estimated JavaScript value budget and a 1,024-group cap on complete extension caches. Aggregating another scan switches the cache. Publications and deletions of unrelated scans leave cached results usable. Deleting the cached scan invalidates it after commit, and worker restart clears it.

In a disposable Windows run against the production Storage Worker, a historical snapshot with 100,151 entries and 70,150 root children took 200 ms to validate and 240 ms to open through the first page. A cached reopen took under 1 ms, and repeated 100-entry pages at offset 10,000 took 24 ms at the median. A 128-entry scanner batch acknowledged in 210 ms when queued during validation and 12 ms without competing work. The scanner batch ran before an already queued read once validation finished. Task 5.23 should account for cold validation on larger snapshots because synchronous validation occupies the Storage Worker until it finishes.

A separate disposable production Worker run analyzed two archives with 100,151 and 80,101 entries and a Latest snapshot with 60,076 entries. The first historical Insights adoption took 109 ms, including 105 ms of tree validation. After Explorer validated the second archive, Insights adopted it in 1.71 ms with no second validation. Switching through category results took 86 ms to Latest and 156 ms back to the first archive. Cold category and extension queries took 351 and 403 ms, while cached aggregate medians ranged from 0.17 to 0.22 ms. The cache peaked at 51,132 estimated bytes and the largest analytics SQL result contained 50 aggregate rows.

The 128-entry scanner batch acknowledged in 366 ms when queued during the cold category query and 11 ms uncontended. The batch dispatched ahead of a read already queued when the category query finished. Task 5.23 should account for cold aggregate queries as well as tree validation when assessing scanner acknowledgement latency.

The global history target defaults to 10 completed snapshots and accepts integers from 1 through JavaScript’s maximum safe integer. The settings API saves the limit as `history-retention.json` in Electron’s `userData` directory by syncing a temporary file and atomically replacing the previous file. A missing file uses the default. Invalid persisted settings suspend pruning until an explicit valid save. Settings controls are planned for Task 5.18.

Automatic retention prunes the oldest eligible snapshot by publication sequence, one transaction per snapshot. It preserves Latest and protected snapshots and can temporarily exceed the target. Maintenance resumes when a relevant lease is released and defers while a scan is building. A confirmed publication stands independently of pruning. The limit controls retained snapshot count. Deleted rows free SQLite pages for later writes, so the database file may stay near its previous peak size.

The full History page, history management controls, Comparison UI, storage trends, duplicate detection, file cleanup, and background monitoring are planned for later tasks.

## Snapshot comparison contracts

A comparison is an ordered pair of distinct retained completed scan IDs. Baseline and Target stay fixed across publications. Reversing the pair swaps additions and removals and reverses signed deltas. A future default can use publication sequence for the older Baseline and newer Target.

Schema v2 retains the Phase 4 root and entry metadata and adds publication order. The official scanners behind both schemas resolve absolute native paths, use read-only traversal with `lstat`, record symlinks without traversing them, and count logical bytes per regular-file entry. These shared invariants establish the traversal policy for current and migrated snapshots. Neither schema stores per-scan options, source platform, volume or inode identity, per-path coverage, or content hashes. The compatibility helper infers path style from recognizable native path syntax and reports insufficient metadata when style or policy cannot be established.

Compatibility requires the same lexical root and traversal policy. Root normalization handles trailing separators, Windows drive letters, and conventional UNC paths while preserving exact component case, including server and share names. POSIX backslashes are literal. A nested root is a different scope. The same root path can refer to different physical volumes or objects over time. Opening a compatible pair still requires authorization and validation of both stored trees.

### Matching and coverage

The matching key is the root-relative path with slash separators and exact UTF-16 components. The empty key represents the root directory. Descendant keys must be within the root at a component boundary. Reject escaping components, ambiguous path spellings, and duplicate keys within either snapshot. Preserve case, Unicode code units, and literal POSIX backslashes. Entry IDs serve as snapshot-scoped Explorer references.

A file record represents one path with a known regular file on at least one side. A confirmed missing file is Added or Removed. A directory, symlink, or other known non-file at the same path establishes a type replacement with the corresponding file-side event. An observed unknown entry type or unconfirmed absence yields Indeterminate. Two observed files are Modified when known logical size or the stored millisecond modification time differs. The scanner writes UTC ISO timestamps, and unusable stored timestamps count as unknown. Unchanged requires both fields to be known and equal. This establishes metadata equality. Creation time, content equality, and rename or move detection are outside this policy. Renamed or moved paths are classified independently.

The scanner persists a global error count and discards individual traversal error events during ingestion. A missing row can establish absence on a side with zero reported errors. An incomplete or unknown coverage side leaves missing paths indeterminate. An observed file or known replacement remains usable on either side. Scans observe a live tree and can miss concurrent changes even when traversal reports no errors.

If users need more definitive changes from partial snapshots, a future schema could add scan-scoped coverage markers at the smallest reliable subtree. The Scanner Worker would report that scope and whether the entry or its children could be enumerated. Batch ingestion would commit markers with the corresponding scan, and deletion would cascade to them. An explicit per-scan coverage capability would distinguish a scan with no markers from one produced before the feature. Older snapshots would keep the global fallback. This is an optional precision improvement for a later task.

### Byte accounting and queries

Known sizes and counts are non-negative safe integers. Deltas are signed Target minus Baseline safe integers. Confirmed absence of a regular file contributes zero to file accounting, including known type replacements. An unknown size or uncertain presence yields a null delta. A file with known sizes and unknown modification times may have a known byte delta with an Indeterminate classification.

The five file counts are mutually exclusive and sum to the number of distinct file-centric keys. Confirmed byte totals sum known deltas from confirmed classifications and separately count confirmed changes whose deltas are unknown. Indeterminate rows do not contribute to that total. The difference between the two stored known-byte totals measures observed snapshot accounting and can differ from confirmed change totals or actual growth. Directory rows report observed subtree totals and count each descendant file key once per subtree. Nested rows overlap, so the overall summary must aggregate file keys directly. Future SQL should keep exact integer intermediates, reject overflow with `SIZE_OVERFLOW`, and convert only checked values to JavaScript numbers.

### Storage Worker path matching

The Worker validates both completed trees using its existing eight-snapshot validation cache. It prepares one connection-local `STRICT, WITHOUT ROWID` temporary table for the directional pair. Each UTF-16BE BLOB primary key holds the observed Baseline and Target entry IDs. The empty BLOB represents the root directory on both sides. Fetching a row joins the IDs back to their original scans, preserving types, nulls, and known zero bytes. A missing side represents an unobserved entry.

Schema v2 indexes entries by scan and entry ID, by parent, and by the scan root. These indexes narrow each source and look up its parent or entry. The stored absolute path has a different identity from the canonical relative key. Computing that key in a join or CTE would repeat normalization for future queries or need a fresh index or sort for each query. A prepared `INSERT … SELECT` statement per side seeks by entry ID in batches of up to 512. The scalar function processes one entry and its parent at a time, reuses the normalized root, and rejects invalid keys and inconsistent parent paths. Same-side conflicts leave the batch short of its expected count, which rejects the pair and rolls back preparation.

Temporary storage uses SQLite's file-backed mode with a 4 MiB suggested temporary page cache. The table grows with the union of keys. JavaScript holds no entry array during preparation. Each bounded SQL call limits the number of temporary native-to-JavaScript callback values, and returning from the call makes them eligible for collection. An inspection request reads at most 101 rows to return a page of up to 100. Pages seek from the last canonical BLOB key. SQL binary equality and ordering preserve UTF-16 code units, including lone surrogates. Later directory filters must respect path-component boundaries, and delta sorts will use the canonical key as a tie-breaker.

The Worker checks both snapshots in the same read transaction as each comparison. Only a successful commit makes a replacement workspace reusable. A failed build rolls back its candidate data. A committed source deletion clears its workspace identity immediately, and the next successful build clears the old temporary rows. Closing the connection or restarting the Worker clears the table. Publication and unrelated deletion leave the workspace valid. The workspace itself holds no view or request leases.

Cold preparation runs in one synchronous Worker request. The coordinator still prioritizes queued scanner writes ahead of queued reads once the active request finishes. Key generation yields no opportunity to preempt the active SQLite request. Scanner acknowledgements can therefore wait for validation and preparation, within the existing storage deadlines. Task 5.16 will add pair authorization and reserve both snapshots for the view and for each scheduled request.

In a disposable Windows run through the production Worker, two historical snapshots had 100,013 entries each. The fixtures included 75,000 matching file paths with independently assigned IDs, 25,000 side-only files per scan, both directions of file and directory replacement, nested directories, Unicode and case variants, and a 70,000-file sibling group. `EXPLAIN QUERY PLAN` showed an indexed `(scan_id, id)` seek for each preparation batch, indexed parent lookups, and a temporary primary-key seek followed by two indexed entry lookups for each page. Both first and cursor pages used that plan without a sort.

Two uninstrumented runs took 2.49–4.62 s for cold preparation and the first page, 3.07–4.28 ms for the median of 24 warm 100-row reads, and 2.24–4.38 s to replace the pair with its reverse. A queued 128-entry scanner batch acknowledged after 2.57–4.64 s, ahead of a waiting read. Its uncontended acknowledgement took 18–20 ms. The existing storage deadlines still apply. One instrumented attempt reached the 10-second request deadline before an isolated instrumented rerun completed.

The isolated instrumented run measured 318 ms in historical integrity queries and 2.14 s preparing the temporary workspace, including 1.19 s inside the canonical-key callbacks. The first page SQL took 0.80 ms. A repeat generated zero keys. With batches of 512, sampled Worker heap peaked at 23 MiB during cold preparation, compared with 159 MiB in the first profiled run with one statement execution per side. Sampled process RSS rose from about 86 MiB to 165 MiB in the isolated run. The temporary database occupied 1,612 pages of 4 KiB each, about 6.30 MiB of SQLite pages. That measurement covers the temporary database page footprint.

### File change queries

The Storage Worker computes file changes from the same path workspace. One SQL relation excludes the root and paths without a regular file, then computes the reason, kind, proven byte contributions, and signed delta. It validates canonical UTC millisecond timestamps, including expanded years supported by the scanner, and preserves stored metadata in the returned observations. Compatibility warnings accompany every page. Task 5.14 can aggregate this relation directly in SQL, and Task 5.15 can reuse its classification and byte rules.

The internal query uses the shared offset and total-count contract. Pages default to 20 rows and allow up to 100. An omitted kind filter includes all kinds, an empty list matches none, and repeating a kind has the same effect as selecting it once. A subtree filter includes the exact key and its descendants within component boundaries. Path order uses UTF-16BE keys. Signed delta sorts place unknown deltas last and break ties by ascending key. The SQL count and page share one transaction, so a past-end offset returns an empty page and the filtered total.

Different filters, sort orders, and offsets reuse the prepared pair. Classification adds no retained rows or indexes to the workspace. The raw match cursor remains available for bounded path inspection. File queries use offsets because they return an exact total and support several orderings. Counts can scan the matching range, and delta sorts may need a temporary SQLite sort. Only the selected page crosses into JavaScript.

The production Worker benchmark used two 100,013-entry snapshots with 125,010 file changes across all five kinds. `EXPLAIN QUERY PLAN` showed indexed workspace and scan-scoped entry lookups for every count and page. Subtree queries added an upper bound to the workspace seek. Path order and counts avoided sorting. Delta order used a temporary B-tree.

| Query for 100 rows                       | Uninstrumented median |
| ---------------------------------------- | --------------------: |
| Raw match page on the same pair          |               3.26 ms |
| Default classified page with exact count |                162 ms |
| Added / Removed                          |          576 / 541 ms |
| Modified / Unchanged / Indeterminate     |    307 / 313 / 321 ms |
| Largest growth / largest reduction       |          412 / 410 ms |
| Offset 110,000, path / delta order       |          319 / 944 ms |
| 5,000-file subtree, all kinds / Modified |            14 / 26 ms |

Cold preparation plus the first classified page took 2.58 s, compared with 2.49–4.62 s for Task 5.12's raw match benchmark. Reversing the large pair took 2.50 s, and switching to the large snapshot paired with a root-only snapshot took 1.28 s. The profiled run measured 340 ms of snapshot validation, 2.22 s executing workspace inserts, and 150 ms for the initial count. For warm default pages, SQL medians were 172 ms for the count and 1.81 ms for the page. A kind-filtered count took 284–323 ms. Sampled peak Worker heap was about 22 MiB cold and 14 MiB on warm queries. The workspace stayed at 1,821 SQLite pages, about 7.11 MiB on this fixture. Temporary space used by the delta sort is outside that page count.

A queued 128-entry scanner batch acknowledged in 2.65 s during cold preparation and 465 ms during a warm growth sort, versus 17 ms when uncontended. In both cases it committed ahead of the next queued read. The initial benchmark attempt reached the existing 10-second deadline. Separate uninstrumented and profiled reruns completed with that deadline in place.

### Planned authorization and protection

Task 5.16 will authorize the exact adopted ordered pair and its adoption identity in Main. Use one registry owner for the adopted pair and one for a single prepared replacement. Each owner holds up to two snapshots, so even a disjoint replacement can validate both candidates while the adopted pair stays protected. Swap only after both candidates validate and the renderer adopts their ticket. Failure, expiry, supersession, view exit, document invalidation, and shutdown release the corresponding owners. This uses at most two of the eight owner slots for Comparison.

Comparison reads will independently reserve both scan IDs from bounded queue admission until the Worker settles or exits. A failed second reservation must release the first. The current 16 queued reads plus one active read would hold at most 34 request leases, alongside up to 16 owner leases, within the 64-ID retention exclusion limit. Publication keeps the pair fixed. A changed adoption invalidates outstanding replies, and a handoff to Explorer keeps the source pair protected until the destination acquires the exact selected snapshot or the handoff ends.

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
