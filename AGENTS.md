# SpaceLens — Agent Instructions

## Project Overview

SpaceLens is a cross-platform desktop application for monitoring, visualizing, and analyzing local filesystem storage usage.

**Coursework topic:** "Розробка застосунку для моніторингу та аналізу використання файлового сховища персонального комп'ютера".

The goal is to build a functional, visually polished desktop application with meaningful filesystem analysis, not a CRUD application or an AI wrapper.

## Technology Stack

- Electron — desktop application
- React + TypeScript — renderer
- Node.js — filesystem and system operations
- electron-vite / Vite — development and build
- Tailwind CSS — styling
- shadcn/ui + Lucide — UI components and icons
- D3 (`d3-hierarchy`) — interactive treemap
- Recharts — statistical charts
- SQLite — persistent scan results and history
- Vitest — unit testing
- electron-builder — packaging

Prefer TypeScript strict mode. Avoid unnecessary dependencies and frameworks. Check compatibility before introducing native Node.js modules.

## Application Architecture

Follow Electron's main / preload / renderer architecture.

**Main process:**

- Filesystem access and scanning
- Analytics and directory-size aggregation
- SQLite operations
- Operating system integrations
- IPC handlers

**Preload:**

- Expose a minimal, typed API through `contextBridge`.
- Never expose unrestricted Node.js or Electron APIs.

**Renderer:**

- React components, UI state, navigation and visualizations
- No direct Node.js filesystem access
- No direct database access

Use shared TypeScript types for IPC contracts. Validate IPC inputs.

Keep business logic separate from UI components.

Use feature-based organization for React code where practical. Avoid unnecessary abstraction layers.

## UI/UX Requirements

Design style: **Modern Dark**.

Use a dark, minimal interface inspired by modern developer tools, with restrained colors, clean typography and consistent spacing.

Default startup screen: **Overview**.

Main sections:

1. Overview — storage devices, disk usage and recent scans
2. Explorer — filesystem visualization and navigation
3. Insights — storage analytics
4. History — previous scans and storage changes

**Explorer layout:**

- Left: directory tree
- Center: interactive treemap
- Right: selected item details
- Bottom: sortable file/directory table

Interactions:

- Single click selects an item.
- Double click navigates into a directory.
- Breadcrumbs and Back/Forward support navigation.
- Directory tree, treemap and table share selection/navigation state.

Prioritize usability and clarity over decorative animations.

## Filesystem Scanning

The scanning engine must:

- Recursively scan user-selected directories.
- Collect file metadata and calculate aggregated directory sizes.
- Keep the UI responsive during scanning.
- Support progress reporting and cancellation.
- Use bounded concurrency.
- Handle inaccessible files and directories gracefully.
- Avoid symbolic-link traversal loops.
- Process large datasets without excessive memory usage.
- Avoid sending individual IPC events for every file.
- Never load an entire large filesystem snapshot into React state.

Use a worker thread for potentially blocking or CPU-intensive scanning operations where appropriate.

Distinguish logical file sizes from operating-system-reported disk usage.

## Data and Analytics

Use SQLite to persist scan sessions and filesystem snapshots.

A completed scan must remain distinguishable from cancelled or incomplete scans.

History compares recorded snapshots rather than pretending to provide continuous filesystem monitoring.

Initial analytics include:

- Largest files and directories
- File type distribution
- Storage usage statistics
- Directory growth between scans

Advanced features such as duplicate detection, developer storage analysis and anomaly detection can be implemented in later phases.

## Safety

Filesystem scanning must be read-only by default.

Never implement automatic deletion, cleanup or modification of user files without explicit requirements and confirmation.

Do not silently execute destructive filesystem or Git commands.

Follow Electron security best practices, including context isolation and disabling Node.js integration in the renderer.

Treat filesystem paths, file names and IPC input as untrusted data.

## Development Guidelines

- Inspect existing code before modifying it.
- Follow established patterns and conventions.
- Prefer small, focused modules and readable code.
- Avoid `any` unless there is a justified reason.
- Handle errors explicitly.
- Do not introduce abstractions without a concrete need.
- Do not implement unrelated features.
- Do not silently change major architectural decisions.
- Prefer incremental implementation over large rewrites.
- Keep the application runnable after each completed task.

## Task Scope and Git Workflow

- Treat each task as one small, independently verifiable change.
- Do not implement functionality planned for future tasks.
- Keep changes focused on the current task.
- Run relevant checks after implementation.
- Do not create Git commits unless explicitly requested.
- Suggest a conventional commit message after each task.
- Preserve the working state of the application.

## Testing and Validation

For each relevant change:

1. Run available TypeScript checks.
2. Run relevant tests.
3. Run linting when configured.
4. Check the application build when applicable.
5. Add tests for nontrivial business logic.
6. Report failures or checks that could not be executed.

Pay special attention to scanner cancellation, inaccessible directories, symbolic links, unusual file names and snapshot consistency.

Never claim that a command or test succeeded unless it was actually executed successfully.

## Documentation

Keep `README.md` accurate and concise.

Do not create additional planning or documentation files unless explicitly requested.

Update documentation only when the change materially affects usage, architecture or setup.

## Working with the User

For substantial tasks, briefly explain the implementation approach before making changes.

For small, straightforward tasks, implement directly.

After completing a task, summarize:

- What changed
- Important implementation decisions
- Validation performed
- Known limitations or remaining work

Ask before introducing major dependencies, changing the architecture or significantly expanding scope.

Do not attempt to implement the entire application in a single task.

**The current user request defines the development scope. Do not implement later-phase functionality unless requested.**
