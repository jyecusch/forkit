# Forkit

A fast, cross-platform desktop git client that treats worktrees as first-class.

Forkit stays responsive on repositories with very long histories, thousands of branches and tags, and heavy daily activity. History is laid out in Go and the window only ever receives the rows on screen. Every open repository is watched, so the UI updates as soon as anything changes on disk.

## Features

- **Repositories as tabs, worktrees as sub-tabs.** Create a worktree from any branch, tag or remote branch, switch between them, and remove them when you're done.
- **Commit graph that scales.** Lanes are computed incrementally in Go. The graph is drawn on a canvas beside virtualized commit rows, and the first screen appears while the rest of history is still streaming in.
- **Emphasis.** Click any branch to show its first-parent history at full strength and dim everything else.
- **Checkout that understands worktrees.** Double-click to check out. Forkit asks what to do with uncommitted changes (stash and reapply, or bring them along) and offers to jump to a worktree that already has the branch. It creates tracking branches for remote branches and confirms before detaching HEAD at a tag.
- **Live.** File edits, commits, fetches and rebases made outside Forkit show up within about 100 ms.
- **Observable.** Every action is traced end to end, from the click through the Go backend to each git process it runs. Traces stay on your machine unless you configure an OTLP endpoint.

## Install

Forkit is pre-release. There are no signed builds yet, so build it from source (below).

Forkit uses the `git` on your `PATH` (2.36 or newer), or another binary set in Preferences.

## Build from source

Requirements: Go 1.26+, [Bun](https://bun.sh), the [Wails v2 CLI](https://wails.io/docs/gettingstarted/installation) and git 2.36+. On Linux you also need `libgtk-3-dev` and `libwebkit2gtk-4.1-dev`.

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0
wails build                    # on Linux: wails build -tags webkit2_41
open build/bin/Forkit.app      # macOS
```

For development with hot reload, run `wails dev`. See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, performance checks and tracing.

## How it works

Go owns git and the frontend owns pixels:

- **Backend (Go).** Runs the system `git` CLI and builds entities from its output. It lays out history and watches each repository's git dirs and worktrees, then pushes sequenced deltas of everything that changed.
- **Frontend (React + Effect).** Mirrors those deltas into TanStack DB collections and renders them, asking for windows of graph rows as you scroll.
- **One data model.** [`schema/forkit.schema.json`](schema/forkit.schema.json) defines every entity once. Go structs and Effect Schemas are generated from it.

[docs/architecture.md](docs/architecture.md) covers the design in more detail, along with the decisions made so far.

## License

[MIT](LICENSE)
