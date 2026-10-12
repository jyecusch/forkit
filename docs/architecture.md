# Architecture

Forkit is a [Wails](https://wails.io) app. A Go backend drives the system `git` CLI and a React frontend renders in the system webview. This document describes how the pieces fit and records the decisions made along the way.

## Data flow

```
 git CLI ──► internal/repo, internal/graph ──► internal/synchub ──► Wails events ──► SyncClient ──► TanStack DB ──► React
    ▲                                                 ▲                                                               │
    │             internal/watch (fsnotify/FSEvents) ─┘                                                               │
    └────────────── internal/workspace ◄── internal/rpc ◄── Rpc service ◄── Commands service ◄────────── user actions ┘
```

- **Synced entities** (repos, worktrees, refs, remotes, file status, graph views, operations, preferences, session) are small. The backend publishes the full current state of a channel scope, such as one repository's refs; the hub diffs it against what it last sent and emits a sequenced delta. Clients take a snapshot, apply deltas whose `prevSeq` matches, and take a fresh snapshot after a gap.
- **Windowed entities** (graph rows and commits) are never synced. A `GraphView` announces each new layout version along with the first row that changed. The frontend fetches 500-row blocks around the viewport and keeps unchanged blocks across versions.
- **Writes** are RPC commands. They run through a per-repository write lock, are published as `Operation`s while they run, and are confirmed by the deltas that follow.

## Graph layout

`git log --topo-order --format="%H %P"` streams into a compact in-memory history. Oids are interned to integer IDs with a custom hash index, which keeps a 1.3-million-commit repository at about 80 MB.

Lanes are assigned in a single pass. Only each row's lane and thread are stored, plus a checkpoint of the lane state every 512 rows. Edges for a window are replayed from the nearest checkpoint, so they never have to be stored for the whole history.

When refs only move forward, new commits are read with the old tips excluded, prepended, and the whole history re-laid out in memory (about 30 ms for 1.3M commits). Anything else, such as a force push, triggers a streaming reload.

Emphasis is the first-parent chain from the emphasized ref's tip, computed as a bitset over rows and cached per layout version.

Git streams topologically ordered history only when the repository has a commit-graph file. Forkit writes one in the background if it is missing (Preferences → Git), because without it git computes the whole order before printing the first commit.

## Performance budgets

| Budget | Where it is checked |
| --- | --- |
| Open to first graph window < 300 ms | `internal/perf` |
| Change on disk to UI update < 100 ms | `internal/perf` (status and ref churn) |
| Emphasis switch < 50 ms | `internal/perf` |
| < 150 MB per repository | `internal/perf` |

Run them against repositories from `tools/synthrepo`; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Decisions

These answer the plan's open questions and record where the implementation differs from it.

- **Wails v2.** v3 was still in beta when work started (v3.0.0-beta.28).
- **JSON Schema with a small in-repo generator** (`tools/schemagen`) rather than TypeSpec. One dependency-free tool produces both the Go types and the Effect Schemas. The backend validates hand-edited preference files against the same schema at runtime.
- **Emphasis is the first-parent line**, and the emphasized branch keeps its lane rather than moving left, so switching emphasis never re-lays out the graph.
- **Worktrees are sub-tabs**, as in the design mockup.
- **System git is required**, version 2.36 or newer. Forkit does not bundle git.
- **One window.** Tearing tabs into their own windows is not in v0.1.
- **The session stores `{id, commonDir}` per open repository**, not just IDs, because an ID is a hash and the repository must be found again on restart.
- **`GraphView` omits `emphasizedRefId` and `includedRefs`.** Emphasis is a parameter of each window request, so switching it never invalidates the layout. Which refs are drawn comes from the graph preferences.
- **The sync package is `synchub`**, to avoid shadowing Go's `sync`.
- **Commit text is read per window** through one long-running `git cat-file --batch` process, rather than kept in memory.
- **Layouts are not cached on disk yet.** With a commit-graph file the first window arrives in about 40 ms even on very large repositories, so the cache was deferred.
- **Reads run with `GIT_OPTIONAL_LOCKS=0`**, so Forkit never contends with your own git commands. As a result, `git status` cannot save its refreshed stat cache, so Forkit refreshes each worktree's index once when the repository opens.
- **Diffs are read one file at a time** when a file is opened, by streaming `git diff` (or `diff-tree` for a commit) with the whole file as context, so changes are shown where they sit. Reading stops at 50,000 lines, and the diff says so. A worktree's status summary carries a revision that counts up on every status read, so an open diff of uncommitted changes reloads when its file changes.
- **Code is highlighted with Lezer in a Web Worker.** Lezer's parsers are plain JavaScript, so there is no regex engine or WASM to load, and each language is a separate chunk loaded the first time it is needed. Both sides of a diff are parsed as whole files, so strings and comments that span lines colour correctly, and tokens come back as one typed array. Colours are per-theme CSS variables, so highlighting follows the theme.
- **Fetch, pull and push use the user's own git credentials.** Network commands run detached from any terminal, so ssh or git can never stop to ask for a password nobody can see. Credential helpers, credential managers' sign-in windows and the SSH agent still work; anything that needs typing in a terminal fails with an explanation instead.
- **A pull is a fetch, then a merge or rebase that Forkit chooses** from the pull preference (fast-forward only by default), with uncommitted changes stashed for its duration. Pulling never depends on how git's own pull is configured.
- **Pushes force only with a lease**, so a force push is refused if the remote branch moved since it was last fetched.
- **Remotes are fetched in the background** at the interval in the preferences, starting from when FETCH_HEAD was last written. After each failure the interval doubles, to at most eight times as long, and failures show on the remote instead of interrupting.
- **Frontend spans reach the backend** through Effect's OTLP tracer with a custom HttpClient that calls a Wails binding. Backend and frontend spans share one exporter: a rotating local file by default, or OTLP when configured.

## Not yet built

From the roadmap: staging hunks and lines, discarding changes, and commit signing; prompting for credentials inside Forkit; merge, rebase, conflict resolution, stash management, search, blame and reflog undo; signing, notarization, installers and auto-update; the diagnostics panel, command palette and an accessibility pass.

Also planned: resizable panels throughout (the sidebar, the details panel, the graph column, the unstaged and staged sections and the diff's panes), with their sizes remembered.
