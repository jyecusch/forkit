package graph

import (
	"crypto/sha256"
	"fmt"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
)

// buildHistory parses a DAG given as one "commit: parent parent" line per row
// in display order.
func buildHistory(t testing.TB, spec string) (*History, []string) {
	t.Helper()
	h := newHistory()
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(spec), "\n") {
		name, parents, _ := strings.Cut(strings.TrimSpace(line), ":")
		var parentOIDs [][]byte
		for _, parent := range strings.Fields(parents) {
			parentOIDs = append(parentOIDs, fakeOID(parent))
		}
		if err := h.Append(fakeOID(name), parentOIDs); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	return h, names
}

func fakeOID(name string) []byte {
	sum := sha256.Sum256([]byte(name))
	return sum[:20]
}

// render describes each row as "name lane/thread | edges below", where an
// edge is from>to with an m suffix for merges and f for forks.
func render(g *Graph, names []string) string {
	edges := g.edgesBelow(0, g.Len())
	var b strings.Builder
	for row, p := range g.placements {
		fmt.Fprintf(&b, "%s %d/%d |", names[row], p.lane, p.thread)
		for _, e := range edges[row] {
			fmt.Fprintf(&b, " %d>%d%s", e.fromLane, e.toLane, map[edgeKind]string{edgeStraight: "", edgeMerge: "m", edgeFork: "f"}[e.kind])
		}
		b.WriteString("\n")
	}
	return b.String()
}

func TestLayoutGolden(t *testing.T) {
	cases := map[string]struct{ spec, want string }{
		"linear": {
			spec: `
				c: b
				b: a
				a:`,
			want: `
c 0/0 | 0>0
b 0/0 | 0>0
a 0/0 |`,
		},
		"merged feature branch": {
			spec: `
				m: x y
				y: b
				x: b
				b: a
				a:`,
			want: `
m 0/0 | 0>0 0>1f
y 1/1 | 0>0 1>1
x 0/0 | 0>0 1>0m
b 0/0 | 0>0
a 0/0 |`,
		},
		"two unmerged tips": {
			spec: `
				feature: base
				main: base
				base:`,
			want: `
feature 0/0 | 0>0
main 1/1 | 0>0 1>0m
base 0/0 |`,
		},
		"merge of a branch that is already drawn": {
			spec: `
				topic: m
				m: x topic2
				topic2: x
				x:`,
			want: `
topic 0/0 | 0>0
m 0/0 | 0>0 0>1f
topic2 1/1 | 0>0 1>0m
x 0/0 |`,
		},
		"octopus with duplicate parent": {
			spec: `
				o: a b c b
				c: a
				b: a
				a:`,
			want: `
o 0/0 | 0>0 0>1f 0>2f
c 2/2 | 0>0 1>1 2>2
b 1/1 | 0>0 1>0m 2>0m
a 0/0 |`,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h, names := buildHistory(t, tc.spec)
			got := strings.TrimSpace(render(Layout(h), names))
			want := strings.TrimSpace(tc.want)
			if got != want {
				t.Errorf("got\n%s\n\nwant\n%s", got, want)
			}
		})
	}
}

// randomHistory builds a plausible busy history: mostly linear work on a few
// long-lived branches with frequent merges between them.
func randomHistory(t testing.TB, commits int, seed uint64) *History {
	rng := rand.New(rand.NewPCG(seed, seed))
	// Commit k's parents are older commits, written in reverse so children
	// precede parents.
	spec := make([]string, commits)
	for k := range commits {
		var parents []string
		if k > 0 {
			parents = append(parents, fmt.Sprint(k-1-rng.IntN(min(k, 3))))
		}
		if k > 10 && rng.IntN(6) == 0 {
			parents = append(parents, fmt.Sprint(k-2-rng.IntN(min(k-1, 40))))
		}
		spec[commits-1-k] = fmt.Sprintf("%d: %s", k, strings.Join(parents, " "))
	}
	h, _ := buildHistory(t, strings.Join(spec, "\n"))
	return h
}

func TestWindowEdgesMatchFullReplay(t *testing.T) {
	g := Layout(randomHistory(t, 3000, 1))
	full := g.edgesBelow(0, g.Len())
	for _, window := range [][2]int{{0, 10}, {511, 513}, {1000, 1600}, {2990, 3000}, {2047, 2048}} {
		got := g.edgesBelow(window[0], window[1])
		if !reflect.DeepEqual(got, full[window[0]:window[1]]) {
			t.Errorf("window %v differs from the full replay", window)
		}
	}
}

func TestExtendMatchesSinglePass(t *testing.T) {
	h := randomHistory(t, 2000, 2)
	whole := Layout(h)

	partial := newHistory()
	streamed := Layout(partial)
	for row := range h.Len() {
		parents := h.Parents(row)
		parentOIDs := make([][]byte, len(parents))
		for i, p := range parents {
			parentOIDs[i] = h.oidOf(p)
		}
		if err := partial.Append(h.oidOf(h.rowID[row]), parentOIDs); err != nil {
			t.Fatal(err)
		}
		if row%300 == 0 {
			streamed.Extend()
		}
	}
	streamed.Extend()

	if !reflect.DeepEqual(streamed.placements, whole.placements) {
		t.Error("streamed placements differ from a single pass")
	}
}

func TestFirstParentChain(t *testing.T) {
	h, _ := buildHistory(t, `
		m: x y
		y: b
		x: b
		b: a
		a:`)
	g := Layout(h)
	bits := g.firstParentChain(1) // y
	var on []int32
	for row := range int32(g.Len()) {
		if hasBit(bits, row) {
			on = append(on, row)
		}
	}
	if want := []int32{1, 3, 4}; !reflect.DeepEqual(on, want) {
		t.Errorf("chain rows = %v, want %v", on, want)
	}
}

func BenchmarkLayout(b *testing.B) {
	h := randomHistory(b, 200_000, 3)
	b.ResetTimer()
	for range b.N {
		Layout(h)
	}
}
