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

The History API reads completed scan metadata in pages of 20 by default, with at most 100 scans per request. Root filters match stored paths case-sensitively, with literal substring search available. Offset-based pages reflect the current history on each read. Overview refreshes its first five rows after committed publication, deletion, or pruning, using the history revision on the scanner-state channel. A snapshot can expire between listing it and using an Overview action. Explorer and Insights acquire protection through their selection lifecycle when opening one.

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

History lists retained completed snapshots with literal path filtering, publication and size sorting, and 20-row pages. The table shows Latest by publication ID and flags partial scans with known error counts. It refreshes after publication, deletion, or retention pruning while keeping the selected filter, sort order, and page where possible. Browsing history does not hold snapshot protection.

History actions and retention settings, the Comparison UI, storage trends, duplicate detection, file cleanup, and background monitoring are planned for later tasks.

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

Cold workspace preparation runs in one synchronous Worker request. The coordinator prioritizes queued scanner writes ahead of queued reads once the active request finishes. Key generation holds the Worker until the SQLite request completes, so scanner acknowledgements can wait behind workspace preparation. The public comparison path authorizes the adopted pair and reserves both snapshots for each scheduled request.

In a disposable Windows run through the production Worker, two historical snapshots had 100,013 entries each. The fixtures included 75,000 matching file paths with independently assigned IDs, 25,000 side-only files per scan, both directions of file and directory replacement, nested directories, Unicode and case variants, and a 70,000-file sibling group. `EXPLAIN QUERY PLAN` showed an indexed `(scan_id, id)` seek for each preparation batch, indexed parent lookups, and a temporary primary-key seek followed by two indexed entry lookups for each page. Both first and cursor pages used that plan without a sort.

Two uninstrumented runs took 2.49–4.62 s for cold preparation and the first page, 3.07–4.28 ms for the median of 24 warm 100-row reads, and 2.24–4.38 s to replace the pair with its reverse. A queued 128-entry scanner batch acknowledged after 2.57–4.64 s, ahead of a waiting read. Its uncontended acknowledgement took 18–20 ms. The existing storage deadlines still apply. One instrumented attempt reached the 10-second request deadline before an isolated instrumented rerun completed.

The isolated instrumented run measured 318 ms in historical integrity queries and 2.14 s preparing the temporary workspace, including 1.19 s inside the canonical-key callbacks. The first page SQL took 0.80 ms. A repeat generated zero keys. With batches of 512, sampled Worker heap peaked at 23 MiB during cold preparation, compared with 159 MiB in the first profiled run with one statement execution per side. Sampled process RSS rose from about 86 MiB to 165 MiB in the isolated run. The temporary database occupied 1,612 pages of 4 KiB each, about 6.30 MiB of SQLite pages. That measurement covers the temporary database page footprint.

### File change queries

The Storage Worker computes file changes from the same path workspace. One SQL relation excludes the root and paths without a regular file, then computes the reason, kind, proven byte contributions, and signed delta. It validates canonical UTC millisecond timestamps, including expanded years supported by the scanner, and preserves stored metadata in the returned observations. Compatibility warnings accompany every page. Directory analysis shares this relation and its byte rules.

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

### Comparison summary

The summary includes both completed-snapshot records, compatibility warnings, and signed Target-minus-Baseline changes in stored logical bytes, file count, and directory count. The persisted directory counts include the roots. The stored byte difference measures the difference between the snapshots' observed known logical sizes. It may diverge from the net of calculable file deltas when coverage or sizes are incomplete.

SQLite groups the shared file classification relation in one pass, returning at most five aggregate rows. Counts include zero-byte changes and explicit zeroes for missing kinds. The summary distinguishes positive, signed negative, and net known deltas from the confirmed-only aggregates, which exclude Indeterminate records. Known zeroes count as known deltas. Unknown deltas have their own count. The Worker keeps aggregate arithmetic exact with SQLite integers and BigInt, checks the safe-integer range and reconciliation, and only then serializes numbers. Complete pairs with fully known contributions must reconcile with the observed snapshot delta.

The Worker retains one successful summary in the current directional workspace after the transaction commits. Metadata, compatibility, and source availability are checked on each retrieval. Replacement, source deletion, and Worker disposal clear the cached summary. Unrelated publication and deletion leave it available. Unfiltered file pages can reuse its exact count across sorts and offsets. Kind and subtree filters still count in SQL.

The Windows benchmark used snapshots of 100,013 entries each. The partial pair exercised all five kinds, with 95,008 known and 30,002 unknown deltas. Its observed byte delta was +439,995 bytes and its net known file delta was +1,332,203 bytes. The separate complete pair reconciled exactly. The summary plan used one workspace primary-key range scan and two indexed entry lookups, with a temporary B-tree for grouping. A same-Worker probe produced equivalent totals with a sort-free conditional aggregate. Its median was 635 ms versus 260 ms for grouping, so the grouped implementation keeps one classification pass and returns at most five rows.

| Production Worker measurement                  |        Uninstrumented result |
| ---------------------------------------------- | ---------------------------: |
| Cold preparation plus first summary            |                       1.65 s |
| Warm workspace, first summary                  |                       263 ms |
| Cached summary median                          |                      0.20 ms |
| Unfiltered 100-row page before / after summary | 95 ms / 2.15 ms median after |
| Reverse partial pair / switch to complete pair |              1.49 s / 2.28 s |

The profiled cold request took 2.43 s, including 172 ms of historical validation, 1.86 s of workspace inserts, and 384 ms of aggregation. Warm aggregate SQL took 386 ms. The warm file count before summary reuse took 170 ms under profiling, close to Task 5.13's 172 ms. Task 5.13's uninstrumented reference took 2.58 s cold and 162 ms for the warm default page with a count. Sampled Worker heap peaked at 23 MiB cold, 10 MiB during warm aggregation, and 38 MiB during the profiled pair switch. The workspace stayed at 1,821 pages, about 7.11 MiB. That page count excludes the grouping work area.

A 128-entry scanner batch acknowledged in 1.77 s during cold summary preparation and 274 ms during warm uncached aggregation, versus 8–9 ms uncontended. Task 5.13 measured 2.65 s queued cold and 465 ms during a warm delta sort. In both summary scenarios the scanner write committed before the waiting read. Active aggregation remains synchronous. The measured runs completed within the existing 10-second deadline.

### Directory change analysis

Directory queries reuse the prepared path workspace and each validated directory's persisted aggregate for observed size differences. A confirmed missing directory or a known non-directory replacement contributes zero directory bytes. An uncertain missing directory leaves the observed delta unknown. Navigation references identify directory entries in the exact saved snapshot. The type-replacement flag identifies a known non-directory at the same key.

Presence determines the status for a directory observed on one side. A confirmed absence or known type replacement yields Added or Removed, and an uncertain opposite side yields Indeterminate. A directory observed on both sides is Modified when any strict descendant has a confirmed file change or directory addition or removal. This includes timestamp-only file changes and empty directory changes with a zero-byte delta. Otherwise the directory is Indeterminate when coverage, descendant classification, or byte accounting is incomplete. Unchanged means the available file metadata and directory structure establish no change under these rules. Directory timestamps and the contents of known non-directory special entries are outside this classification. The uncertainty flag also applies to confirmed changes, including changes recorded during a globally incomplete scan.

One temporary row per directory stores its canonical BLOB primary key, side-specific directory IDs, parent link, observations, and rollup totals. Two partial indexes map scan-scoped directory IDs to these keys. SQL groups classified files by immediate parent and kind before folding those groups into the directory rows. The Worker then visits directories in descending key order in batches of up to 512 keys. A parent sorts after its descendants in that order, so one indexed update per child adds the completed totals to its parent. This avoids a separate file scan per directory and an ancestor-by-descendant table. JavaScript holds only one key batch and a bounded result page.

Subtree file counts include strict descendants. A file involved in an exact-key directory replacement belongs to the parent directory's totals. Nested rows overlap intentionally, so ranking rows cannot be added to derive global change. Root statistics include files directly under the root and reconcile with the independent Comparison Summary. Complete subtrees with known deltas reconcile with the observed size difference. The Worker checks numeric ranges before serializing totals.

Directory pages use the existing kind and subtree filters, exact counts, and offsets. Subtree filtering includes the selected key and its descendants. The root is opt-in through `includeRoot`. Signed growth and reduction sorts rank unknown deltas last, breaking ties by ascending UTF-16BE key. The directory table becomes reusable only after a successful transaction. Source deletion, pair replacement, and Worker disposal invalidate it alongside the matching workspace. Unrelated mutations leave the prepared pair and its summary usable.

The Windows production Worker benchmark used 98,429 entries and 16,925 directories per snapshot, including 45,000 file siblings, 16,000 directory siblings, and a 120-level branch. It exercised complete and incomplete pairs, empty directory changes, type replacements, and positive, negative, zero, and unknown contributions. The pair had 17,725 non-root directory records. The query plan showed one workspace scan to seed directory facts and one classified file pass with two grouping steps. Parent resolution used the side-specific ID indexes. Each rollup update looked up its child and parent by primary key. Path and subtree pages sought over the BLOB index, and delta sorts used a temporary B-tree.

| Production Worker measurement                   |           Uninstrumented result |
| ----------------------------------------------- | ------------------------------: |
| Cold preparation and first directory page       |                          2.43 s |
| Cold summary followed by first directory page   | 1.93 s for summary, then 901 ms |
| Warm path page                                  |                  3.51 ms median |
| Warm growth / reduction page                    |           6.32 / 6.88 ms median |
| Warm modified directories scoped to the catalog |                  5.91 ms median |
| Offset 16,000, path / delta order               |          5.60 / 24.26 ms median |
| Warm root page                                  |                  0.57 ms median |
| Reverse pair / switch to complete pair          |                 3.05 s / 2.74 s |

In the profiled warm-workspace preparation, seeding and parent resolution took 250 ms, direct file aggregation took 511 ms, and reading key batches and rolling them up took 202 ms. The indexed root reconciliation read took 0.023 ms before comparison of the totals. Sampled Worker heap peaked at 24 MiB cold, 10 MiB while preparing directories after the summary, and 11 MiB on warm pages. Matching used 6.73 MiB of SQLite pages on this fixture, compared with Task 5.14's 7.11 MiB on its fixture. Directory state added 5.24 MiB of SQLite pages, for 11.96 MiB total. This excludes temporary grouping and ranking work areas.

Scanner batches acknowledged after 2.44 s during cold directory preparation and 911 ms when the matching workspace already existed, versus 9–10 ms uncontended. They committed ahead of the waiting read. Task 5.14's reference summary took 1.65 s cold and 263 ms on a warm workspace, with scanner acknowledgements of 1.77 s and 274 ms.

### Comparison IPC, selection, and protection

The preload exposes metadata compatibility, prepare and adopt, ticket discard and selection release, Summary, and bounded File and Directory Changes pages. Compatibility uses stored metadata and carries coverage warnings. Preparation atomically reserves both scan IDs, checks compatibility, and validates each saved tree through the historical cache. Main issues one expiring, single-use ticket for the authorized renderer document. Adoption keeps the pair directional and assigns a new selection ID each time. An analytical request must match both IDs and the current adoption, including when the Worker can serve cached data. Publication leaves an explicit pair selected.

Comparison uses one owner for the adopted pair and another for one provisional replacement. A disjoint replacement can hold four distinct snapshots. Explorer and Insights each use one owner for up to two snapshots. Across the three views this is four of the eight existing owner slots and up to eight view leases. One active and 16 queued reads can hold up to 34 additional request leases. Even if all eight owner slots were allocated, 50 leases would fit under the 64-ID retention exclusion limit. Both sides reject manual deletion while protected and are excluded from retention pruning. Releasing the last lease lets deferred retention resume. Explorer can prepare and adopt a side through the existing historical selection flow while Comparison retains both sources for the duration of the handoff.

Every admitted comparison read independently reserves both sides. The coordinator removes obsolete queued requests immediately and keeps dispatched holds until the Worker replies or exits. Supersession, view exit, document invalidation, ticket expiry, and shutdown release the affected view owners. Storage exit also invalidates the selection. The shared queue retains its 10-second queue-wait deadline, the Worker retains its 10-second per-command deadline, and preparation tickets expire after 10 seconds. Scanner writes have dispatch priority and their acknowledgements still follow commit.

### Task 5.16 baseline and failure

The cold analytical request builds the matching workspace inside a synchronous transaction. The first directory query can also build its rollup within a single request. The existing SQL batches share a transaction with the workspace and its cache state, so yielding between those batches would let unrelated writes enter an open transaction or require exposing partially built state.

The Task 5.16 benchmark used Node 24.21 on Windows, the production Worker bundle, the real Main IPC handlers, and a simulated Electron sender. The fixture held 98,426 and 98,427 entries, including 16,924 and 16,925 directories. Two newer small publications made both sources historical. The scanner submitted 128-entry batches while comparison operations ran.

| Operation                          |  IPC elapsed | Worker execution | Competing scanner ACK |
| ---------------------------------- | -----------: | ---------------: | --------------------: |
| Compatibility                      |       9.2 ms |           1.9 ms |                       |
| Prepare both historical trees      |       1.18 s |           1.11 s |                629 ms |
| Adopt                              |      0.94 ms |                  |                       |
| Cold Summary                       |       8.62 s |           8.61 s |                8.68 s |
| First File Changes page            |      21.5 ms |          13.3 ms |                       |
| First Directory Changes page       |       4.05 s |           4.04 s |                4.12 s |
| Warm Summary, files, directories   | 2.6/17/11 ms |      1.3/13/7 ms |                       |
| Filtered files, sorted by delta    |       869 ms |           864 ms |                       |
| Cached preparation in reverse      |       8.1 ms |           3.5 ms |                       |
| Disjoint replacement prepare/adopt |  13.6/0.5 ms |           8.1 ms |                       |
| Reversed cold Summary              |       9.06 s |           9.06 s |                9.14 s |
| Abandon before dispatch            |       3.1 ms |                  |                       |

Warm rows report medians of five calls. Uncontended scanner acknowledgement took 31 ms. The scanner committed between the 566 ms and 541 ms tree validations. Routine dispatch gaps were under 4 ms in this run. A deliberately queued warm request spent 43 ms waiting for dispatch and 1.1 ms executing. SQLite TEMP allocation was 8.36 MiB after matching and 13.66 MiB after directory preparation. Sampled JavaScript heap peaked at 19.13 MiB during comparison work. These samples cover allocated TEMP pages and JavaScript heap.

Timing varied between runs on the same large entry fixture. An earlier run with the Target still Latest measured 1.20 s for cold Summary and 683 ms for first Directory Changes, with scanner acknowledgements of 1.21 s and 694 ms. Both runs completed the representative workflow within the current deadlines. The slower run left less than one second of execution headroom on reversal.

The stress fixture held 210,551 and 210,552 entries, including 35,324 and 35,325 directories. Pair preparation took 2.88 s and its scanner batch acknowledged in 1.50 s. In Task 5.16, the dispatched cold Summary hit its Worker deadline at 10.01 s. The client marked storage failed and requested Worker termination. The synchronous SQLite operation could continue until the Worker exited. The queued scanner batch had never been dispatched and had no Worker execution timer or successful acknowledgement. The coordinator rejected it when storage failed.

In a scanner session, rejection of that batch fails the pre-acknowledgement callback and ends the scan. There is no batch retry. The session attempts to discard the incomplete scan because the batch was never sent, but the failed Worker cannot accept the discard. Startup recovery removes the building snapshot. The previous completed publication remains committed and becomes readable again when storage reopens.

### Task 5.16a scheduling safety

`beginScan` reserves scanner admission in the existing coordinator before the building write queues. It drops queued Comparison reads and holds admission through building creation, ingestion, publication, or cancellation cleanup. While the scanner holds admission, storage-backed compatibility, historical pair validation, Summary, and File and Directory Changes return `COMPARISON_SCAN_ACTIVE` without dispatching. Filtered counts, delta sorts, and historical validation can occupy the Worker even on an already prepared pair. The same-snapshot compatibility check, adopting a prepared ticket, and releasing or discarding a selection remain Main-side operations. Snapshot protection and workspace reuse still apply.

If a Comparison job has dispatched, a scanner start returns `SCAN_COMPARISON_BUSY` without creating a building snapshot or scheduling a retry. The caller can retry after the job settles. Queue priority alone cannot preempt the synchronous Worker operation. Explorer, Insights, history, and deletion continue through their existing coordinator paths.

An obsolete Comparison reply can be discarded before the Worker settles. Its dispatch reservation and both request leases survive until the reply or confirmed Worker exit. Comparison queue and Worker timeouts surface as `COMPARISON_TIMEOUT`. A Worker execution timeout makes subsequent storage requests unavailable until recovery, and a queued timeout leaves the Worker running. Worker failure, compatibility, and snapshot errors retain their separate outcomes.

The Task 5.16a benchmark used the production Scanner and Storage Worker bundles, Main IPC handlers with a simulated Electron sender, and disposable databases on Windows. Each scanner run traversed 300 files and published after three acknowledged batches. Both admission orders were exercised on the two Task 5.16 fixtures.

| Measurement                             | 98,000 entries per snapshot | 210,000 entries per snapshot |
| --------------------------------------- | --------------------------: | ---------------------------: |
| Scanner-first startup / completion      |                 65 / 507 ms |                  31 / 554 ms |
| Scanner-first batch acknowledgements    |                    19–36 ms |                     23–81 ms |
| Scanner-first rejected Comparison reads |                           5 |                            5 |
| Comparison-first cold Summary IPC       |                      8.94 s |           10.01 s to timeout |
| Comparison queue wait                   |                     0.64 ms |                      0.73 ms |
| Scanner busy reply                      |                     4.64 ms |                      4.70 ms |
| Scanner retry startup / completion      |                 32 / 501 ms |                  62 / 563 ms |
| Scanner retry batch acknowledgements    |                    24–59 ms |                     20–79 ms |

The scanner-first runs queued zero Comparison commands. The first batch spent 5.16 ms and 6.31 ms waiting, including the benchmark gate used to send the conflicting requests. Retry batches waited at most 0.03 ms. In Comparison-first runs, the busy response and a duplicate-start rejection produced zero building writes. The representative Summary spent 8.94 s executing on the Worker, and the scanner retried on that Worker. In the stress case, the benchmark held termination briefly to verify that both request leases survived the timeout, then observed zero leases 52 ms after allowing exit. Recovery preserved the previous publication and both source snapshots. An explicit scanner retry then published after reopening storage.

### Task 5.23 optimization plan

For Task 5.23, give one candidate workspace an identity tied to the Worker and pair, and retain both source reservations across all of its stages. Build and validate ordered path ranges and roll up directories from children to parents in separately dispatched, measured chunks that each close their transaction. Keep the candidate inaccessible to analytical queries until an atomic promotion checks the pair and candidate identity. Discard stale or failed candidates once dispatched work settles. Benchmark both stage duration and scanner acknowledgement delay on the same fixtures, including contention and deadline cases, before choosing chunk sizes.

Keep mutual exclusion for workloads with unpredictable duration. Before permitting overlap, establish bounds for historical validation, cache misses, filtered counts, delta sorting, and directory rollups. Rerun both scanner-first and comparison-first scenarios with the same deadlines and verify publication and cancellation cleanup under contention.

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
