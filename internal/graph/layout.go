package graph

import "slices"

const noRow = -1

// noLane marks a lane that is not set.
const noLane = -1

// lane is a vertical track heading down to a commit that has not been
// reached yet.
type lane struct {
	expect int32 // id of the commit the lane leads to; -1 when the lane is free
	thread int32
	// firstParentOf is the row whose first-parent link this lane draws, or
	// noRow when it draws a merge's other parent, so a branch keeps its lane.
	firstParentOf int32
	// forkedAt is the row whose commit opened this lane for a non-first
	// parent, so no line enters it from above at that row.
	forkedAt int32
	// uncommitted marks the lane reserved for a worktree's uncommitted
	// changes, which runs down to the commit they build on.
	uncommitted bool
	// stash marks a lane from a stash down to the commit it was made on.
	stash bool
}

// uncommittedThread and stashThread are the threads of uncommitted changes
// and stashes. They are not numbered with the branches', so branch colours
// stay put as changes and stashes come and go.
const (
	uncommittedThread = -1
	stashThread       = -2
)

// edge is a line from a lane at one row to a lane at the next.
type edge struct {
	fromLane, toLane int32
	thread           int32
	kind             edgeKind
	uncommitted      bool
	stash            bool
}

type edgeKind uint8

const (
	edgeStraight edgeKind = iota
	edgeMerge             // converges into the commit on the next row
	edgeFork              // leaves this row's commit for another lane
)

// placement is where a row's commit is drawn.
type placement struct {
	lane, thread int32
}

// layout assigns lanes one row at a time. The same steps run for the initial
// pass, which keeps only placements, and when replaying from a checkpoint to
// produce the edges of a window, so both always agree.
type layout struct {
	lanes      []lane
	nextThread int32
	row        int32 // last row placed
	prevLane   int32 // lane of the last row's commit
	// rootLane is the lane of the last row's commit if it was a root, which
	// the next row's new branch tip stays out of: a history starting right
	// below where another ends would look like its continuation.
	rootLane int32
	forks    []int32
}

// newLayout starts a layout. With uncommitted >= 0, the first lane is kept
// for uncommitted changes building on that commit, so every row above it is
// placed clear of their line.
func newLayout(uncommitted int32) *layout {
	l := &layout{row: noRow, rootLane: noLane}
	if uncommitted >= 0 {
		l.lanes = []lane{{expect: uncommitted, thread: uncommittedThread, firstParentOf: noRow, forkedAt: noRow, uncommitted: true}}
	}
	return l
}

func (l *layout) clone() *layout {
	c := *l
	c.lanes = slices.Clone(l.lanes)
	c.forks = slices.Clone(l.forks)
	return &c
}

// place positions commit id, whose parents are given, on the next row. When
// edges is non-nil the lines from the previous row down to this one are
// appended to it. A stash has one parent, the commit it was made on.
func (l *layout) place(id int32, parents []int32, stash bool, edges *[]edge) placement {
	row := l.row + 1
	target := l.laneFor(id)
	if edges != nil {
		l.appendEdgesInto(id, target, edges)
	}

	thread := l.lanes[target].thread
	switch {
	case stash:
		thread = stashThread
	case l.lanes[target].expect != id || l.lanes[target].uncommitted || l.lanes[target].stash:
		thread = l.newThread()
	}
	for i := range l.lanes {
		if l.lanes[i].expect == id {
			l.lanes[i] = lane{expect: -1}
		}
	}

	l.forks = l.forks[:0]
	if len(parents) == 0 {
		l.finishPlacing(row, target)
		l.rootLane = target
		return placement{lane: target, thread: thread}
	}
	if stash {
		// Not a first-parent link, so the commit keeps its branch's lane.
		l.lanes[target] = lane{expect: parents[0], thread: thread, firstParentOf: noRow, forkedAt: noRow, stash: true}
		l.finishPlacing(row, target)
		return placement{lane: target, thread: thread}
	}
	l.lanes[target] = lane{expect: parents[0], thread: thread, firstParentOf: row, forkedAt: noRow}
	for i, parent := range parents[1:] {
		if slices.Contains(parents[:i+1], parent) {
			continue
		}
		forkLane := l.laneExpecting(parent, target)
		if forkLane < 0 {
			forkLane = l.freeLane(target)
			l.lanes[forkLane] = lane{expect: parent, thread: l.newThread(), firstParentOf: noRow, forkedAt: row}
		}
		l.forks = append(l.forks, forkLane)
	}
	l.finishPlacing(row, target)
	return placement{lane: target, thread: thread}
}

func (l *layout) finishPlacing(row, commitLane int32) {
	l.trimFreeLanes()
	l.row = row
	l.prevLane = commitLane
	l.rootLane = noLane
}

// appendEdgesInto emits every line between the previous row and the row of
// commit id, which is about to be drawn in lane target.
func (l *layout) appendEdgesInto(id, target int32, edges *[]edge) {
	destination := func(i int32) int32 {
		if l.lanes[i].expect == id {
			return target
		}
		return i
	}
	for i, ln := range l.lanes {
		lane := int32(i)
		if ln.expect < 0 || ln.forkedAt == l.row {
			continue
		}
		to := destination(lane)
		kind := edgeStraight
		if to != lane {
			kind = edgeMerge
		}
		*edges = append(*edges, edge{fromLane: lane, toLane: to, thread: ln.thread, kind: kind, uncommitted: ln.uncommitted, stash: ln.stash})
	}
	for _, forkLane := range l.forks {
		to := destination(forkLane)
		*edges = append(*edges, edge{fromLane: l.prevLane, toLane: to, thread: l.lanes[forkLane].thread, kind: edgeFork})
	}
}

// appendTrailingEdges emits lines below the last row, for lanes whose next
// commit has not been loaded yet.
func (l *layout) appendTrailingEdges(edges *[]edge) {
	for i, ln := range l.lanes {
		if ln.expect >= 0 {
			lane := int32(i)
			*edges = append(*edges, edge{fromLane: lane, toLane: lane, thread: ln.thread, kind: edgeStraight, uncommitted: ln.uncommitted, stash: ln.stash})
		}
	}
}

// laneFor picks the lane for commit id: the leftmost lane drawing a child's
// first-parent link to it, so a branch keeps its colour, then any lane heading
// to it, then the leftmost free lane for a new branch tip.
func (l *layout) laneFor(id int32) int32 {
	fallback := int32(-1)
	for i, ln := range l.lanes {
		if ln.expect != id {
			continue
		}
		if ln.firstParentOf != noRow {
			return int32(i)
		}
		if fallback < 0 {
			fallback = int32(i)
		}
	}
	if fallback >= 0 {
		return fallback
	}
	return l.freeLane(l.rootLane)
}

func (l *layout) laneExpecting(id, except int32) int32 {
	for i, ln := range l.lanes {
		if ln.expect == id && int32(i) != except {
			return int32(i)
		}
	}
	return -1
}

// freeLane returns the leftmost free lane other than except, adding one if
// every lane is in use. A lane added never takes except's place.
func (l *layout) freeLane(except int32) int32 {
	for i, ln := range l.lanes {
		if ln.expect < 0 && int32(i) != except {
			return int32(i)
		}
	}
	l.lanes = append(l.lanes, lane{expect: -1})
	if int32(len(l.lanes)-1) == except {
		l.lanes = append(l.lanes, lane{expect: -1})
	}
	return int32(len(l.lanes) - 1)
}

func (l *layout) trimFreeLanes() {
	for len(l.lanes) > 0 && l.lanes[len(l.lanes)-1].expect < 0 {
		l.lanes = l.lanes[:len(l.lanes)-1]
	}
}

func (l *layout) newThread() int32 {
	l.nextThread++
	return l.nextThread - 1
}
