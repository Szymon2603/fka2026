# Add unwanted marks + filter toggle

**Date:** 2026-10-18
**Status:** Approved (brainstorming)
**OpenSpec change:** `add-unwanted-marks`

## Why

User wants to mark films they don't intend to watch, then filter them out of the daily/plan views. This complements the existing "selected" (chcę obejrzeć) set with a third orthogonal state: "unwanted" (nie chcę oglądać). Without it, the user must either ignore films visually or maintain the filter in their head — both get worse as the program grows.

## What Changes

- New `Set<string> unwanted` mirrors `selected`, persisted under `fka2026.unwanted.v1`.
- `selected ∩ unwanted = ∅` enforced at every mutation (rejecting a film removes it from `selected`; selecting a film removes it from `unwanted`).
- `computeConflicts` filters out unwanted films — they don't constrain the user's real plan.
- New per-film `✕` toggle button next to `✓`. Click semantics:
  - If neutral: mark unwanted.
  - If selected: remove from selected, mark unwanted.
  - If unwanted: clear unwanted (back to neutral).
- New toolbar toggle "Pokaż odrzucone" on day-view and plan-view (off by default, not persisted, matches existing transitions-filter pattern).
- When unwanted films are visible (toggle on): greyed background, struck-through title, `✕` icon shown. When hidden (toggle off): row absent from the rendered list.
- Snapshot format (`?import=` URL and JSON file) gains a third slice `unwanted: [...]`, validated identically to `selected`. Old snapshots without the field are accepted and treated as empty set.

## Capabilities

### New Capabilities

- `planner-rejection`: per-film "unwanted" decision with its own UI, persistence, and visibility toggle. The system MUST enforce that unwanted films never constrain conflict detection.

### Modified Capabilities

- `plan-sharing` (in `openspec/specs/plan-sharing/spec.md`): the **Snapshot schema** requirement gets a new `unwanted: [screeningId, ...]` field. `applySnapshot` MUST treat absent field as empty set. **Sanitization** requirement MUST apply the same ID filter as `selected`.

## Architecture

### State

```js
const UNWANTED_KEY = 'fka2026.unwanted.v1';
let unwanted = new Set();          // Set<screeningId>
function loadUnwanted() { /* localStorage read; on parse fail → empty */ }
function saveUnwanted() { /* JSON.stringify([...unwanted]) */ }
```

### Invariant enforcement

A single helper `setRejected(id, rejected)` is the only entry point for mutations:

```js
function setRejected(id, rejected) {
  if (rejected) {
    if (selected.has(id)) { selected.delete(id); saveSelected(); }
    unwanted.add(id);
  } else {
    unwanted.delete(id);
  }
  saveUnwanted();
  renderActiveView();
}
```

`toggleSelect(id)` (the existing `✓` handler) gains a symmetric "clear unwanted" call before adding to `selected`.

### Conflict detection

`computeConflicts` builds its `sel` list from `data.screenings.filter(s => selected.has(s.id))`. **Unwanted is excluded entirely.** This means rejecting a film can only *decrease* conflict count, never increase. Travel-time and overlap messages never reference unwanted films.

### Filter toggle

A boolean `showUnwanted` lives in module scope, **not** in `localStorage`. Default `false`. UI: a small checkbox on the day-view and plan-view toolbars, labelled "Pokaż odrzucone (N)" where N is the count of unwanted films in the current scope (day or all).

`renderDay()` and `renderPlan()` filter their `screeningToListItem` list by:
- If `showUnwanted` is false: `s => !unwanted.has(s.id)`
- Else: keep all

The list-item rendering checks `unwanted.has(s.id)` and applies a `.rejected` CSS class.

### UI

**Per-film button layout** (day-view and plan-view):
```
[  time  ]  Title
[  body  ]  meta · venue · section
            [✕][✓]
```

Both `✕` and `✓` are circular buttons. `✓` keeps its current checked/unchecked visual. `✕` is filled red when `unwanted.has(id)`, otherwise ghost-style outline.

**Rejected visual** (when `showUnwanted` is on):
- Background: `var(--surface-2)` (subtle grey).
- Title: `text-decoration: line-through; color: var(--text-3);`
- `✓` button hidden or disabled.
- `✕` button prominent (clicking clears unwanted).

### Snapshot

`buildSnapshot()`:
```js
return {
  v: 1,
  app: 'fka2026',
  selected: [...selected],
  unwanted: [...unwanted],          // NEW
  transitions: [...transitions.entries()],
  settings: { ...settings },
};
```

`applySnapshot(snap)`:
- Accept when `v === 1 && app === 'fka2026'`.
- `unwanted` is **optional**: missing or non-array → keep current `unwanted`. (Backward compatibility: snapshots produced by `v1` of the build code will have no `unwanted` field; we still import them correctly.)
- When present: filter to IDs existing in `data.screenings`. Set internally. Persist.

## Data Flow

1. User opens day view. `renderDay()` builds the list, applies `unwanted` filter based on `showUnwanted`.
2. User clicks `✕` on a film. `setRejected(id, true)` removes from `selected` if present, adds to `unwanted`, persists, re-renders. The row disappears (default filter).
3. User clicks "Pokaż odrzucone (3)". `showUnwanted = true`. `renderDay()` re-runs, showing three rows with `.rejected` styling.
4. User clicks `✕` on a visible rejected film. `setRejected(id, false)` removes from `unwanted`, persists, re-renders. The row reverts to neutral style.
5. User clicks "📋 Kopiuj link". `buildSnapshot()` includes `unwanted`. The URL works as before, just with one more slice.
6. User opens the URL on another device. Banner shows "5 seansów · 2 odrzuconych · 3 własnych przejść · reklamy: 10 min". Accept → both `selected` and `unwanted` are imported.

## Edge Cases

- **Selected → rejected**: `setRejected` calls `selected.delete` first, then `unwanted.add`. The film transitions cleanly; `computeConflicts` immediately stops considering it.
- **Rejected → selected**: `toggleSelect` calls `unwanted.delete` first, then `selected.add`.
- **Two films A (rejected) and B (selected) overlap**: A is not in `sel`, so no conflict is reported. User sees B with no conflict badge even though a hidden A would have caused one. This is the intended simplification.
- **Toggle "Pokaż odrzucone" off, on, off rapidly**: handled — `showUnwanted` is plain state, no animation or persistence to worry about.
- **Stale ID in `unwanted` (program updated, film no longer exists)**: `applySnapshot` filters unknown IDs. The runtime in-memory `unwanted` may also contain stale IDs — `setRejected` only ever removes, never silently reconciles. A small startup helper `reconcileUnwanted()` removes IDs not in `data.screenings` after data load. (Same pattern as the share-snapshot sanitization.)
- **Conflicting key in localStorage** (e.g. another tab): existing `storage` event handler in `init()` already covers `STORAGE_KEY`; we extend it to `UNWANTED_KEY`.
- **Toggle visibility of unwanted in plan-view**: yes, also available. User might want to see them as a "comparison" before deciding. The toggle label says "Pokaż odrzucone" identically in both views.
- **Total counts** in plan-summary: "X seansów / Y odrzuconych" (Y only shown when > 0 or when toggle is on).

## Testing

Manual checks before commit:
1. Fresh open: no unwanted, no toggle visible rows, no `.rejected` style.
2. Mark 2 films as unwanted via `✕`. Both disappear from day view. Plan view also reflects (no rejected films appear in plan by default).
3. Toggle "Pokaż odrzucone". Two rows appear with strikethrough. Counts match.
4. Clear one via `✕`. Now 1 rejected, count updates.
5. Re-mark it via `✕`. Toggle off. Rejected disappears again.
6. Mark a *selected* film as unwanted. `✓` clears, `✕` lights up. The plan-summary count drops by one. No conflict remains for that film.
7. Export snapshot. Open in private window with import URL. Banner shows "X odrzuconych". Accept → state matches.
8. Import an old snapshot (no `unwanted` field). State import is correct; `unwanted` is unchanged in the importing browser.

## Migration Plan

No migration. New key in `localStorage` is created on first rejection. Old snapshots still work (field is optional).

**Rollback:** revert commit. No data shape changed for existing users. Any unwanted marks would be lost from localStorage, but the user can re-mark them.

## OpenSpec artifacts to produce

1. `openspec/changes/add-unwanted-marks/proposal.md` (Why, What Changes, Capabilities)
2. `openspec/changes/add-unwanted-marks/specs/planner-rejection/spec.md` (full new capability)
3. `openspec/changes/add-unwanted-marks/specs/plan-sharing/spec.md` (delta: MODIFIED Requirements for `Snapshot schema` and `Snapshot sanitization`)
4. `openspec/changes/add-unwanted-marks/design.md` (links to this file plus decisions)
5. `openspec/changes/add-unwanted-marks/tasks.md` (numbered checklist)

After apply: archive the change, sync the two specs (`planner-rejection` new file, `plan-sharing` modified in place).

## Open Questions

None. Decisions were resolved in the brainstorming flow.
