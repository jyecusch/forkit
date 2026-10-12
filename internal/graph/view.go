package graph

import (
	"context"
	"slices"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/synchub"
)

// publishInterval limits how often a streaming load announces new rows.
const publishInterval = 100 * time.Millisecond

// Options choose which history a view shows.
type Options struct {
	Order          model.GraphOrder
	IncludeRemotes bool
	IncludeTags    bool
	// Uncommitted is the commit the active worktree's uncommitted changes
	// build on, which gets a lane of their own from the top; empty for none.
	Uncommitted model.OID
}

// View is the laid-out history of one repository. It is safe for concurrent
// use; Refresh calls are serialized. Locks are taken in the order refreshMu,
// mu, emphasisMu.
type View struct {
	repoID  model.RepoID
	repo    *gitexec.Repo
	channel synchub.Channel[model.GraphView]
	tracer  trace.Tracer
	commits *commitReader

	refreshMu sync.Mutex

	mu              sync.RWMutex
	graph           *Graph
	tips            []model.OID
	options         Options
	complete        bool
	version         int
	firstChangedRow int
	refTips         map[model.RefID]model.OID
	refsAt          map[model.OID][]model.RefID
	branchThreads   map[string]int

	emphasisMu sync.Mutex
	emphasis   emphasisCache
}

type emphasisCache struct {
	graph  *Graph
	rows   int
	tipRow int32
	bits   []uint64
}

// NewView creates an empty view. ctx bounds the lifetime of the git process
// it keeps open for reading commits.
func NewView(ctx context.Context, repoID model.RepoID, repo *gitexec.Repo, channel synchub.Channel[model.GraphView], tracer trace.Tracer) *View {
	return &View{
		repoID:  repoID,
		repo:    repo,
		channel: channel,
		tracer:  tracer,
		commits: newCommitReader(ctx, repo),
	}
}

// Close releases the view's git process.
func (v *View) Close() { v.commits.Close() }

// Refresh brings the view up to date with the repository's refs and worktree
// heads. When the only change is new commits on top of what is shown, they
// are prepended without walking the whole history again.
func (v *View) Refresh(ctx context.Context, refs []model.Ref, heads []model.OID, options Options) error {
	v.refreshMu.Lock()
	defer v.refreshMu.Unlock()
	ctx, span := v.tracer.Start(ctx, "graph.refresh", trace.WithAttributes(attribute.String("repo.id", string(v.repoID))))
	defer span.End()

	tips := collectTips(refs, heads, options)
	v.mu.RLock()
	current, currentTips, currentOptions, complete := v.graph, v.tips, v.options, v.complete
	v.mu.RUnlock()

	sameView := current != nil && currentOptions == options
	// Only the uncommitted changes' lane differs: the history is laid out again
	// in memory rather than read again.
	sameHistory := current != nil && sameHistoryOptions(currentOptions, options)
	switch {
	case sameView && complete && slices.Equal(currentTips, tips):
		span.SetAttributes(attribute.String("graph.refresh", "refs"))
		v.install(ctx, current, tips, options, complete, refs)
		return nil
	case sameHistory && complete && slices.Equal(currentTips, tips):
		span.SetAttributes(attribute.String("graph.refresh", "relayout"))
		v.install(ctx, Layout(current.history, options.Uncommitted), tips, options, complete, refs)
		return nil
	case sameView && complete:
		onlyAdded, err := allReachable(ctx, v.repo, currentTips, tips)
		if err != nil {
			return err
		}
		if onlyAdded {
			span.SetAttributes(attribute.String("graph.refresh", "prepend"))
			return v.prepend(ctx, current, currentTips, tips, options, refs)
		}
	}
	span.SetAttributes(attribute.String("graph.refresh", "reload"))
	return v.reload(ctx, tips, options, refs)
}

func (v *View) prepend(ctx context.Context, current *Graph, currentTips, tips []model.OID, options Options, refs []model.Ref) error {
	newer := newHistory()
	err := streamLog(ctx, v.repo, options.Order, tips, currentTips, func(batch []logEntry) error {
		return appendEntries(newer, batch)
	})
	if err != nil {
		return err
	}
	// New commits on top always keep topological order, but in date order
	// they may belong further down, among older commits.
	if options.Order == model.GraphOrderDate {
		var top model.OID
		if current.Len() > 0 {
			top = current.history.OID(0)
		}
		fits, err := leadsWith(ctx, v.repo, options.Order, tips, newer, top)
		if err != nil {
			return err
		}
		if !fits {
			return v.reload(ctx, tips, options, refs)
		}
	}
	merged, err := current.history.Prepend(newer)
	if err != nil {
		return err
	}
	v.install(ctx, Layout(merged, options.Uncommitted), tips, options, true, refs)
	return nil
}

// reload walks the whole history, showing it as soon as the first batch of
// rows is laid out and growing it as git produces more.
func (v *View) reload(ctx context.Context, tips []model.OID, options Options, refs []model.Ref) error {
	history := newHistory()
	g := Layout(history, options.Uncommitted)
	if len(tips) == 0 {
		v.install(ctx, g, tips, options, true, refs)
		return nil
	}
	shown := false
	var lastPublish time.Time
	err := streamLog(ctx, v.repo, options.Order, tips, nil, func(batch []logEntry) error {
		v.mu.Lock()
		previousRows := g.Len()
		err := appendEntries(history, batch)
		g.Extend()
		if shown {
			v.version++
			v.firstChangedRow = max(previousRows-1, 0)
		}
		v.mu.Unlock()
		if err != nil {
			return err
		}
		if !shown {
			shown = true
			v.install(ctx, g, tips, options, false, refs)
			lastPublish = time.Now()
		} else if time.Since(lastPublish) >= publishInterval {
			v.publish(ctx)
			lastPublish = time.Now()
		}
		return nil
	})
	if err != nil {
		return err
	}
	v.install(ctx, g, tips, options, true, refs)
	return nil
}

// install makes g the shown layout, bumps the version and publishes it.
func (v *View) install(ctx context.Context, g *Graph, tips []model.OID, options Options, complete bool, refs []model.Ref) {
	v.mu.Lock()
	v.graph, v.tips, v.options, v.complete = g, tips, options, complete
	v.refTips, v.refsAt = indexRefs(refs)
	v.branchThreads = branchThreads(g, refs)
	v.version++
	v.firstChangedRow = 0
	v.mu.Unlock()
	v.publish(ctx)
}

func (v *View) publish(ctx context.Context) {
	v.mu.RLock()
	view := model.GraphView{
		ID:              v.repoID,
		Version:         v.version,
		TotalRows:       v.graph.Len(),
		LaneCount:       v.graph.LaneCount(),
		Complete:        v.complete,
		FirstChangedRow: v.firstChangedRow,
		BranchThreads:   v.branchThreads,
	}
	v.mu.RUnlock()
	_ = v.channel.Publish(ctx, string(v.repoID), []model.GraphView{view})
}

// Window returns rows [start, start+count) with their commits. Rows on the
// first-parent history of emphasized are flagged.
func (v *View) Window(ctx context.Context, start, count int, emphasized model.RefID) (model.GraphWindow, error) {
	ctx, span := v.tracer.Start(ctx, "graph.window", trace.WithAttributes(
		attribute.Int("rows.start", start), attribute.Int("rows.requested", count)))
	defer span.End()

	if start < 0 || count < 0 {
		return model.GraphWindow{}, apperr.New(model.ErrorCodeInvalidArgument, "row window must not be negative")
	}
	window, oids := v.layoutWindow(start, count, emphasized)
	commits, err := v.commits.Read(oids)
	if err != nil {
		return model.GraphWindow{}, err
	}
	window.Commits = commits
	return window, nil
}

// layoutWindow copies the rows of a window out of the graph. Rows past the
// end are left out.
func (v *View) layoutWindow(start, count int, emphasized model.RefID) (model.GraphWindow, []model.OID) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	window := model.GraphWindow{Version: v.version, Start: start}
	g := v.graph
	if g == nil || start >= g.Len() {
		return window, nil
	}
	end := min(start+count, g.Len())
	edges := g.edgesBelow(start, end)
	bits := v.emphasisBits(g, v.refTips[emphasized])
	oids := make([]model.OID, 0, end-start)
	for row := start; row < end; row++ {
		oid := g.history.OID(row)
		oids = append(oids, oid)
		window.Rows = append(window.Rows, v.row(g, row, oid, edges[row-start], bits))
	}
	return window, oids
}

func (v *View) row(g *Graph, row int, oid model.OID, edges []edge, emphasis []uint64) model.GraphRow {
	p := g.placements[row]
	graphRow := model.GraphRow{
		Index:        row,
		OID:          oid,
		Lane:         int(p.lane),
		ThreadID:     int(p.thread),
		RefIDs:       v.refsAt[oid],
		OnEmphasized: hasBit(emphasis, int32(row)),
		Edges:        make([]model.GraphEdge, len(edges)),
	}
	for i, e := range edges {
		graphRow.Edges[i] = model.GraphEdge{
			FromLane: int(e.fromLane),
			ToLane:   int(e.toLane),
			ThreadID: int(e.thread),
			Kind:     edgeKinds[e.kind],
		}
		if e.uncommitted {
			graphRow.Edges[i].Uncommitted = &e.uncommitted
		}
	}
	return graphRow
}

var edgeKinds = map[edgeKind]model.EdgeKind{
	edgeStraight: model.EdgeKindStraight,
	edgeMerge:    model.EdgeKindMerge,
	edgeFork:     model.EdgeKindFork,
}

// sameHistoryOptions reports whether two option sets show the same commits,
// differing at most in the uncommitted changes' lane.
func sameHistoryOptions(a, b Options) bool {
	a.Uncommitted, b.Uncommitted = "", ""
	return a == b
}

// RowOfRef returns the row of the commit a ref points at, or -1 when the ref
// is unknown or its commit is not shown.
func (v *View) RowOfRef(ref model.RefID) int {
	v.mu.RLock()
	defer v.mu.RUnlock()
	oid, ok := v.refTips[ref]
	if !ok || v.graph == nil {
		return -1
	}
	return int(v.graph.history.RowOf(oid))
}

// emphasisBits returns the first-parent chain from tip, reusing the last
// result while the graph and tip are unchanged. Callers hold v.mu.
func (v *View) emphasisBits(g *Graph, tip model.OID) []uint64 {
	tipRow := int32(-1)
	if tip != "" {
		tipRow = g.history.RowOf(tip)
	}
	v.emphasisMu.Lock()
	defer v.emphasisMu.Unlock()
	cache := v.emphasis
	if cache.graph != g || cache.rows != g.Len() || cache.tipRow != tipRow {
		v.emphasis = emphasisCache{graph: g, rows: g.Len(), tipRow: tipRow, bits: g.firstParentChain(tipRow)}
	}
	return v.emphasis.bits
}

// collectTips lists the commits the graph is drawn from, sorted and without
// duplicates so tip sets can be compared.
func collectTips(refs []model.Ref, heads []model.OID, options Options) []model.OID {
	var tips []model.OID
	for _, ref := range refs {
		switch {
		case ref.Kind == model.RefKindLocalBranch,
			ref.Kind == model.RefKindRemoteBranch && options.IncludeRemotes,
			ref.Kind == model.RefKindTag && options.IncludeTags:
			tips = append(tips, commitOf(ref))
		}
	}
	for _, head := range heads {
		if head != "" {
			tips = append(tips, head)
		}
	}
	slices.Sort(tips)
	return slices.Compact(tips)
}

func indexRefs(refs []model.Ref) (map[model.RefID]model.OID, map[model.OID][]model.RefID) {
	tips := make(map[model.RefID]model.OID, len(refs))
	at := make(map[model.OID][]model.RefID, len(refs))
	for _, ref := range refs {
		oid := commitOf(ref)
		tips[ref.ID] = oid
		at[oid] = append(at[oid], ref.ID)
	}
	return tips, at
}

// branchThreads maps each local branch in g to its commit's thread.
func branchThreads(g *Graph, refs []model.Ref) map[string]int {
	threads := map[string]int{}
	for _, ref := range refs {
		if ref.Kind != model.RefKindLocalBranch {
			continue
		}
		if row := g.history.RowOf(commitOf(ref)); row >= 0 && int(row) < g.Len() {
			threads[string(ref.ID)] = int(g.placements[row].thread)
		}
	}
	return threads
}

// commitOf returns the commit a ref points at, peeling annotated tags.
func commitOf(ref model.Ref) model.OID {
	if ref.PeeledOID != "" {
		return ref.PeeledOID
	}
	return ref.TargetOID
}
