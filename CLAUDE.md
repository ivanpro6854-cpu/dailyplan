# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Ежедневник" — a weekly planner website. The UI text is in Russian; keep new UI strings in Russian.

Plain static site, no build step, no dependencies, no tests: `index.html`, `styles.css`, `app.js`.

## Running

Open `index.html` directly in a browser, or serve the folder over HTTP. In the Claude desktop browser pane, a `file://` page is rendered as a static snapshot (no external `app.js`, no `localStorage`), so serve it over `http://localhost` to test it. Python and Node are not installed on this machine; a PowerShell `System.Net.HttpListener` script works as a throwaway static server.

## Architecture (app.js)

- **State**: one object persisted as JSON in `localStorage` under `planner.v1` (the active tab lives under `planner.tab`). Shape:
  - `days`: map of local date key `YYYY-MM-DD` → `[{ id, text, status: 'todo'|'done'|'missed', time: 'morning'|'midday'|'evening' }]`. One flat array per day; the time slot is a field, and the array order is the order inside each slot. Empty days are deleted from the map. `loadState()` gives items from v1 that have no `time` the value `'midday'`.
  - Array order is display order everywhere. Lists are not sorted at render time; the user reorders them by dragging.
  - `tasks`: global tasks `[{ id, text, done }]`.
  - `goals`: `[{ id, title, deadline: 'YYYY-MM-DD'|'', done, steps: [{ id, text, done }] }]`. Progress is derived from `steps`; it is never stored.
  - Changing this shape requires a migration in `loadState()` (or a new storage key), since users' existing data is stored there.
- **Rendering**: there is no framework. Every mutation changes `state` in place and then calls `commit()`, which saves and re-renders everything (`renderWeek`, `renderTasks`, `renderGoals`). DOM is built with the `el(tag, attrs, ...children)` helper. Use `text`/`textContent` for user text, never `innerHTML`.
- Because the DOM is rebuilt on every change, `addForm()` re-focuses its input after a submit by looking it up through a `data-input` key. Inline editing (`makeEditable`, on double-click) uses a `finished` guard because the re-render triggers `blur`.
- **Drag-and-drop** is a custom pointer-events implementation (mouse and touch), not HTML5 DnD. Drop zones have `data-list="<listId>"` (`day:<date>:<slot>`, `tasks`, `goals`, `goal:<goalId>`); items have `data-id`. When a zone wraps its items in a child with `[data-items]` (the day slots do, so dropping on a slot header works), items are inserted into that child. A drag only targets zones of the same kind (`listKind`), so a day item can move across days and slots but not into goals. During the drag the real node is moved around the DOM for a live preview; on drop, `moveItem()` updates `state` and re-renders. Don't change layout while a drag is in progress (for example by revealing hidden sections): the drop position is computed from live element rects.
- **Dates**: weeks start on Monday (`startOfWeek`). The date helpers work on local-midnight `Date`s; don't use `toISOString()` for keys (that would shift dates by time zone). `weekOffset` is in-memory week navigation relative to the current week.
- All `localStorage` access is wrapped in try/catch so the app still works (in memory only) when storage is unavailable.

## Styling (styles.css)

Colors are CSS custom properties on `:root`, with a dark theme under `prefers-color-scheme: dark`. Use the existing tokens (`--done`, `--missed`, `--accent`, …) instead of hard-coded colors. Task status maps to the `.item.done` and `.item.missed` classes.
