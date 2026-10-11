// Command synthrepo writes a git fast-import stream for a large, busy
// repository: a main branch plus many concurrent feature branches that are
// merged back with merge commits. It exists to benchmark Forkit at scale.
//
//	git init big && go run ./tools/synthrepo -commits 1000000 | git -C big fast-import
package main

import (
	"bufio"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
)

func main() {
	commits := flag.Int("commits", 100_000, "number of commits to create")
	branches := flag.Int("branches", 30, "feature branches in flight at once")
	seed := flag.Uint64("seed", 1, "random seed")
	flag.Parse()

	w := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer w.Flush()
	g := &generator{w: w, rng: rand.New(rand.NewPCG(*seed, *seed)), time: 1_500_000_000}

	mainTip := g.commit("refs/heads/main", "Initial commit", 0, 0)
	tips := make([]int, *branches)
	for i := range tips {
		tips[i] = mainTip
	}
	for g.mark < *commits {
		slot := g.rng.IntN(len(tips))
		branch := fmt.Sprintf("refs/heads/feature-%d", slot)
		switch roll := g.rng.IntN(10); {
		case roll < 6:
			tips[slot] = g.commit(branch, "Work on "+branch, tips[slot], 0)
		case roll < 8 && tips[slot] != mainTip:
			mainTip = g.commit("refs/heads/main", "Merge "+branch, mainTip, tips[slot])
			tips[slot] = g.commit(branch, "Start "+branch, mainTip, 0)
		default:
			mainTip = g.commit("refs/heads/main", "Fix on main", mainTip, 0)
		}
	}
}

type generator struct {
	w    *bufio.Writer
	rng  *rand.Rand
	mark int
	time int
}

// commit writes a commit on ref with the given parent marks (0 for none) and
// returns its mark.
func (g *generator) commit(ref, message string, parent, merge int) int {
	g.mark++
	g.time += 60 + g.rng.IntN(600)
	author := fmt.Sprintf("Dev %d <dev%d@example.com> %d +0000", g.rng.IntN(200), g.rng.IntN(200), g.time)
	fmt.Fprintf(g.w, "commit %s\nmark :%d\nauthor %s\ncommitter %s\ndata %d\n%s\n", ref, g.mark, author, author, len(message), message)
	if parent != 0 {
		fmt.Fprintf(g.w, "from :%d\n", parent)
	}
	if merge != 0 {
		fmt.Fprintf(g.w, "merge :%d\n", merge)
	}
	content := fmt.Sprintf("%d\n", g.mark)
	fmt.Fprintf(g.w, "M 100644 inline file-%d\ndata %d\n%s\n", g.mark%1000, len(content), content)
	return g.mark
}
