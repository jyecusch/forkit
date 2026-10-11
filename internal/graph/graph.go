package graph

// checkpointInterval trades memory for the number of rows replayed to
// produce a window's edges.
const checkpointInterval = 512

// Graph is a history with every row placed in a lane. Edges are not stored;
// they are replayed from the nearest checkpoint when a window is requested.
type Graph struct {
	history     *History
	placements  []placement
	checkpoints []*layout // checkpoints[k] is the state before row k*checkpointInterval
	tail        *layout   // state after the last placed row
	laneCount   int
}

// Layout places every row of history.
func Layout(history *History) *Graph {
	g := &Graph{history: history, tail: newLayout()}
	g.Extend()
	return g
}

// Extend places rows appended to the history since the last call.
func (g *Graph) Extend() {
	for row := len(g.placements); row < g.history.Len(); row++ {
		if row%checkpointInterval == 0 {
			g.checkpoints = append(g.checkpoints, g.tail.clone())
		}
		g.placements = append(g.placements, g.tail.place(g.history.rowID[row], g.history.Parents(row), nil))
		g.laneCount = max(g.laneCount, len(g.tail.lanes), int(g.placements[row].lane)+1)
	}
}

// Len is the number of placed rows.
func (g *Graph) Len() int { return len(g.placements) }

// LaneCount is the widest the graph gets.
func (g *Graph) LaneCount() int { return g.laneCount }

// edgesBelow returns, for each row in [start, end), the lines from that row
// down to the next one.
func (g *Graph) edgesBelow(start, end int) [][]edge {
	end = min(end, g.Len())
	if start >= end {
		return nil
	}
	checkpoint := start / checkpointInterval
	replay := g.checkpoints[checkpoint].clone()
	result := make([][]edge, end-start)
	for row := checkpoint * checkpointInterval; row <= end && row < g.Len(); row++ {
		var buf *[]edge
		if above := row - 1; above >= start && above < end {
			buf = &result[above-start]
		}
		replay.place(g.history.rowID[row], g.history.Parents(row), buf)
	}
	if end == g.Len() {
		replay.appendTrailingEdges(&result[end-1-start])
	}
	return result
}

// firstParentChain marks the rows reached from row by following first
// parents, which is the history a branch's own commits form.
func (g *Graph) firstParentChain(row int32) []uint64 {
	bits := make([]uint64, (g.Len()+63)/64)
	for row >= 0 && int(row) < g.Len() {
		bits[row/64] |= 1 << (row % 64)
		parents := g.history.Parents(int(row))
		if len(parents) == 0 {
			break
		}
		row = g.history.RowOfID(parents[0])
	}
	return bits
}

func hasBit(bits []uint64, row int32) bool {
	return row >= 0 && int(row/64) < len(bits) && bits[row/64]&(1<<(row%64)) != 0
}
