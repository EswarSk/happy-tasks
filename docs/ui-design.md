# UI Design - Collaborative Task Workspace

**Status:** Proposed for the take-home implementation

**Frontend:** Next.js App Router

**Design-system foundation:** shadcn/ui with Radix primitives and Tailwind CSS

**Related designs:** [System architecture](./architecture.md) and
[database design](./database-design.md)

## 1. Decision summary

Use shadcn/ui components backed by Radix primitives as the reusable interaction
foundation. Add a thin product-specific token and pattern layer rather than
building primitives from scratch or adopting a visually dominant enterprise
component suite.

Supporting libraries:

- Tailwind CSS for tokens and component styling;
- Lucide for one consistent icon set;
- TanStack Query for remote-state caching and optimistic updates;
- TanStack Table for task-table behavior;
- TanStack Virtual for rendering large task collections;
- React Hook Form with Zod-backed contracts for forms;
- `react-resizable-panels` through the shadcn resizable component for the task
  detail pane.

This combination is practical because the official shadcn documentation already
provides Next.js installation guidance and composable sidebar, data-table,
drawer, sheet, dialog, form, skeleton, badge, and resizable-panel patterns. Its
data-table guidance intentionally uses headless TanStack Table so product-specific
sorting, filtering, and pagination remain under our control.

Radix primitives provide the accessibility behavior that is easy to get wrong:
focus management, keyboard navigation, roles, and common WAI-ARIA interaction
patterns. TanStack Virtual keeps the 10,000-task view from mounting thousands of
rows at once.

Official references:

- [shadcn/ui Next.js installation](https://ui.shadcn.com/docs/installation/next)
- [shadcn/ui sidebar](https://ui.shadcn.com/docs/components/base/sidebar)
- [shadcn/ui data-table guidance](https://ui.shadcn.com/docs/components/base/data-table)
- [shadcn/ui resizable panels](https://ui.shadcn.com/docs/components/resizable)
- [Radix Primitives introduction](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility)
- [TanStack Virtual](https://tanstack.com/virtual/latest)

## 2. Product experience goals

- Make the difficult synchronization behavior visible without turning the UI
  into a debugging console.
- Keep the most common path - find a task, update it, and comment - within one
  workspace.
- Remain responsive with 10,000 tasks through server pagination and UI
  virtualization.
- Make pending, synchronized, conflicting, reconnecting, and failed states
  understandable.
- Use restrained visual styling so reviewers focus on product behavior and
  engineering quality.
- Make every required workflow keyboard accessible.

## 3. Information architecture

```text
/login
  Sign in / create account

/projects
  Project index and create-project action

/projects/:projectId
  Default task workspace with URL-backed filters

/projects/:projectId/tasks/:taskId
  Same workspace with a deep-linkable task detail panel

/projects/:projectId/tasks/:taskId/agentic
  Read-only view of an AI agent run attached to the task (not in the original
  proposal): orchestrator status, its node graph, and its event timeline,
  backed by the agent_runs/agent_run_nodes/agent_run_edges/agent_run_events
  tables.

/projects/:projectId/activity
  Optional full activity view; recent activity also appears in a workspace tab
```

The selected project, selected task, search query, filters, and sort belong in
the URL when they should survive refresh or be shareable. Unsubmitted form input,
open menus, temporary optimistic state, and panel width remain local UI state.

## 4. Workspace layout

### 4.1 Desktop

```text
+----------------------+-----------------------------------+------------------+
| Project sidebar      | Project workspace                 | Task detail      |
|                      |                                   |                  |
| Product mark         | Project name       Live status   | Task title       |
| Project switcher     | Search  Filters  View  + New      | Status/Priority  |
| -------------------- | --------------------------------- | Assignees/Tags   |
| Project A            | Task list or board                | Dependencies     |
| Project B            |                                   | Description      |
| Project C            | virtualized rows/cards            | ---------------- |
|                      |                                   | Comments/Activity|
| + New project        | Load next cursor near viewport    | composer         |
| -------------------- |                                   |                  |
| Demo user menu       |                                   | Save state       |
+----------------------+-----------------------------------+------------------+
```

- The project sidebar is collapsible to icons.
- The task-detail panel is resizable and deep-linkable.
- Closing the detail panel navigates back to the project URL instead of losing
  list position and filters.
- The list is the default view because it exposes pagination, dependencies, and
  scale more clearly than a board.
- A compact Kanban view is optional only after the list and required workflows
  are complete.

### 4.2 Tablet and mobile

- The project sidebar becomes an off-canvas sheet.
- The task table becomes a compact task-card list; do not force a wide desktop
  grid into a narrow viewport.
- Task detail becomes a full-height drawer or route-level page.
- Primary create/save/comment actions remain reachable near the bottom edge.
- Filters open in a sheet and show an active-filter count on the trigger.

Responsive behavior is part of the component contract, not a separate mobile
application.

## 5. Core screens and required states

### 5.1 Project index

Show:

- page title and concise explanation;
- project cards or rows with task counts and last activity;
- create-project button;
- deterministic demo project entry;
- empty state with a direct create action;
- skeleton state and retryable error state.

Creating a project uses a small dialog with name and description. On success,
navigate directly into its workspace.

### 5.2 Project workspace

Header controls:

- project title and description;
- live/reconnecting/offline status indicator;
- task search;
- status, priority, assignee, and tag filters;
- sort control;
- list/board view toggle;
- primary `New task` action.

Task-list columns:

- status;
- task title;
- priority;
- assignee avatars;
- dependency/blocking indicator;
- comment count;
- updated time;
- row action menu.

Keep rows between approximately 44 and 52 pixels high so the virtualizer can
use a stable estimate. A row opens the detail route; inline status changes are
allowed, but complex editing belongs in the detail panel.

### 5.3 Task detail panel

Sections:

1. Header: editable title, task ID copy action, overflow menu, close action.
2. Properties: status, priority, assignees, tags, and custom fields.
3. Description: shipped as a Yjs CRDT-backed collaborative editor rather than the plain textarea originally proposed here — concurrent character-level edits converge instead of last-write-wins.
4. Dependencies: depends-on and blocking lists with searchable add control.
5. Tabs: comments and recent activity.

Use autosave only for small, isolated select changes. Description and multi-field
edits use an explicit save action so optimistic and conflict behavior remains
understandable.

### 5.4 Comments

The comment thread is oldest-to-newest in the UI, while the API fetches the
newest cursor page efficiently and reverses it for display.

```text
[Load older comments]

Avatar  Author                           10:42 AM
        Comment content...
        Reply
        └─ Avatar  Author                10:44 AM
                  Nested reply...
        Pending / Failed retry state when relevant

Avatar  Author                           10:45 AM
        Newly synchronized comment...

---------------------------------------------------
[Current-user avatar]  Write a comment...
                                      [Send]
```

Required behavior:

- sticky composer at the bottom of the detail panel;
- optimistic comment with a visible pending indicator;
- canonical timestamp replaces the optimistic timestamp;
- failure leaves the draft recoverable and provides retry/remove actions;
- replayed and duplicate events do not duplicate comments;
- every comment exposes a reply action and the composer identifies the parent;
- replies are optimistically nested and restore both draft and reply target on failure;
- new remote comments append without shifting older-page cursors;
- deleted comments render a neutral tombstone if edit/delete is implemented;
- optional reactions appear as small toggle chips below a comment.

Do not reverse the whole virtualized history or auto-scroll the user away from
older content. Auto-scroll only when the user is already near the bottom or when
they send a comment themselves; otherwise show a `New comments` affordance.

### 5.5 Dependency interaction

- Search only tasks in the current project.
- Exclude the current task and already-linked dependencies.
- Display status and blocking state in each option.
- Optimistically show the pending dependency.
- Render server domain errors inline, especially `DEPENDENCY_CYCLE`.
- Provide a direct link to each related task.

The UI helps users avoid invalid input, but the Go backend remains authoritative.

## 6. Design-system layers

### 6.1 Layer 1 - tokens

Define semantic CSS variables in one theme file:

```text
surface:       background, panel, raised, hover, selected
text:          primary, secondary, muted, inverse
border:        subtle, default, strong, focus
brand:         primary, primary-hover, primary-foreground
status:        todo, in-progress, blocked, done
priority:      low, medium, high, urgent
feedback:      info, success, warning, danger
realtime:      live, reconnecting, offline
```

Recommended visual direction:

- neutral zinc or slate surfaces;
- one blue or indigo brand accent;
- semantic colors used sparingly in badges and feedback;
- 4-pixel spacing base;
- 8-pixel default radius, 12 pixels for larger panels;
- Geist or the existing Next.js system-font stack;
- restrained shadows, relying mostly on borders and surface contrast.

Support light and dark themes through the same semantic variables, but dark mode
is a cuttable enhancement rather than a core acceptance requirement.

### 6.2 Layer 2 - reusable primitives

Adopt the required shadcn/Radix components into `components/ui`:

- button, input, textarea, label, checkbox, select, combobox;
- badge, avatar, separator, skeleton, spinner, tooltip;
- dialog, alert-dialog, dropdown-menu, popover, command;
- sidebar, sheet, drawer, tabs, scroll-area;
- resizable panel group;
- toast or sonner-style notifications;
- table building blocks.

Do not install every component. Add only components needed by an implemented
screen.

### 6.3 Layer 3 - product patterns

Build thin product components on top of primitives:

- `ConnectionStatus`;
- `ProjectSwitcher`;
- `TaskStatusBadge` and `TaskStatusSelect`;
- `PriorityBadge`;
- `AssigneePicker`;
- `DependencyPicker`;
- `TaskFilters`;
- `TaskTable` and `TaskRow`;
- `TaskDetailPanel`;
- `CommentThread`, `CommentItem`, and `CommentComposer`;
- `OptimisticStateIndicator`;
- `ConflictDialog`;
- `ActivityItem`.

Product patterns accept typed domain values. They do not call endpoint URLs
directly.

### 6.4 Layer 4 - feature composition

Feature folders own queries, mutations, event reconciliation, and screen
composition:

```text
apps/web/
  app/
    projects/
  components/
    ui/
    patterns/
  features/
    projects/
    tasks/
    comments/
    dependencies/
    activity/
    realtime/
  lib/
    api/generated/
    query/
    routes/
```

Route components compose features. UI primitives do not import feature modules,
and feature modules do not bypass the generated API client.

## 7. Server state and real-time reconciliation

TanStack Query owns server-derived state. Use separate query keys for:

```text
projects
project(projectId)
tasks(projectId, filters, sort)
task(projectId, taskId)
comments(projectId, taskId)
activity(projectId)
```

The SSE reconciler is a headless module:

- `task.created`: insert only if it belongs in the current filtered view;
- `task.updated`: patch matching list pages and task detail by ID/version;
- `task.deleted`: remove the entity and close its detail panel if open;
- `comment.created`: append to the matching task thread and update its count;
- `comment.deleted`: replace content with a tombstone;
- `activity.created`: prepend the compact activity item;
- gap or replay expiry: invalidate project-scoped queries and bootstrap again.

Every optimistic mutation stores a rollback snapshot. The canonical HTTP
response replaces optimistic data, while the later SSE event acts as a
version/request-ID confirmation rather than a second UI action.

## 8. Scale and rendering strategy

- Request task pages by opaque cursor, not offset.
- Fetch the next page before the virtualizer reaches the end of loaded rows.
- Render only visible task rows plus a small overscan window.
- Keep row keys stable by task ID.
- Patch one task in cached pages rather than invalidating the full project.
- Memoize task rows around typed row props.
- Lazy-load task description, comments, and dependency detail when the panel
  opens.
- Keep comment pages independent of task pages.
- Use skeleton rows matching final dimensions to avoid layout shifts.
- Preserve list scroll position when opening and closing task detail.

Performance proof should show the DOM contains roughly the visible row count,
not 10,000 task nodes.

## 9. Accessibility and interaction quality

- Use native buttons, links, inputs, and labels through the primitive layer.
- Preserve visible focus rings; never remove outlines without replacement.
- Provide keyboard access for project navigation, task rows, menus, status
  changes, dialogs, and the comment composer.
- Trap and restore focus correctly in dialogs, sheets, and the task drawer.
- Give icon-only controls accessible names and tooltips.
- Do not rely on badge color alone; include text and icons where useful.
- Announce mutation success, rollback, conflict, reconnect, and new comments
  through an appropriate live region without excessive chatter.
- Respect reduced-motion preferences.
- Maintain WCAG AA contrast for ordinary text and interactive states.
- Use at least 44-pixel touch targets for primary mobile controls.

Radix handles much of the primitive behavior, but application-specific labels,
focus destinations, validation messages, and announcements remain our
responsibility.

## 10. Loading, empty, error, and synchronization states

Every remote area must define all states:

| State | UI treatment |
| --- | --- |
| Initial loading | Dimensionally accurate skeletons |
| Empty project | Explanation plus `Create task` action |
| Filter has no results | Clear filters action without implying no project data |
| Mutation pending | Local pending marker; keep unrelated UI interactive |
| Mutation failed | Roll back and show contextual retry guidance |
| Version conflict | Show server value and allow intentional retry |
| SSE reconnecting | Amber connection pill; cached data remains visible |
| Offline | Neutral offline pill; disable unsupported writes or explain retry |
| Replay expired | Re-bootstrap automatically and explain only if recovery fails |
| Slow consumer resync | Preserve selected route and reload project-scoped state |

Avoid global page-blocking spinners after the initial load.

## 11. Two-day implementation order

### Day 1 - functional workspace

1. Establish tokens and adopt only the required primitives.
2. Build the responsive application shell and project sidebar.
3. Implement project list/create and workspace header.
4. Build the paginated task list and task-detail panel.
5. Implement create/edit/status/dependency workflows.
6. Add comments and the headless SSE reconciler.
7. Demonstrate two-browser synchronization before adding visual polish.

### Day 2 - scale proof and polish

1. Add optimistic state, rollback, conflict, and reconnect indicators.
2. Integrate task virtualization and prefetch the next cursor page.
3. Add recent activity using the same event projection.
4. Complete responsive behavior and keyboard/focus paths.
5. Add skeleton, empty, error, and retry states.
6. Run Playwright through the five-minute demo path.
7. Adjust spacing, typography, and visual hierarchy only after behavior passes.

Cut first:

- advanced animations;
- extensive dashboard charts;
- custom illustration work.

Never cut visible synchronization state, rollback/conflict feedback, task-list
virtualization, responsive task detail, or core accessibility.

## 12. UI acceptance criteria

- A first-time reviewer can create a project and task without instructions.
- The primary project workspace works at desktop and mobile widths.
- A 10,000-task project scrolls smoothly while rendering only visible rows.
- Opening task detail preserves list filters and scroll position.
- Every required task field is editable from the detail panel.
- Dependency-cycle errors appear next to the dependency interaction.
- A comment appears optimistically, reconciles with the server, and synchronizes
  to another browser.
- Reconnect, conflict, and rollback states are visible and understandable.
- All dialogs, menus, selects, tabs, and comment actions are keyboard reachable.
- Network inspection confirms that interactions patch entities instead of
  downloading the complete project.

The intended impression is a calm, production-shaped workspace whose most
advanced behavior is visible precisely when it matters.
