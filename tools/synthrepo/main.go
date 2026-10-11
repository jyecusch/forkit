// Command synthrepo generates large repositories for performance testing.
// They are built locally rather than committed because they run to hundreds
// of megabytes.
//
// Each run writes OUT/origin.git, a bare repository, and OUT/repo, a clone
// of it, so remote-tracking branches and fetches behave as they would
// against a real server.
//
// Profiles:
//
//   - busy-branches: a squash-merge workflow over about eighteen months. A
//     mostly linear trunk with frequent lightweight release tags, a few
//     long-lived integration lines, and around 1,900 pushed branches that
//     are never deleted, many of which merge the trunk back in. The history
//     is modest in length but very wide and has thousands of refs, and the
//     pack is inflated by binary assets.
//
//   - deep-history: well over a million commits on a few dozen branches with
//     regular merges, for history walking and layout at scale.
//
//     go run ./tools/synthrepo -profile busy-branches -out ~/forkit-perf/busy
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

func main() {
	profile := flag.String("profile", "busy-branches", "busy-branches or deep-history")
	out := flag.String("out", "", "directory to create")
	scale := flag.Float64("scale", 1, "multiplier on the profile's size, e.g. 0.1 for a quick run")
	flag.Parse()
	if *out == "" {
		log.Fatal("-out is required")
	}
	if _, err := os.Stat(*out); err == nil {
		log.Fatalf("%s already exists", *out)
	}

	generate, ok := map[string]func(*stream, float64){
		"busy-branches": busyBranches,
		"deep-history":  deepHistory,
	}[*profile]
	if !ok {
		log.Fatalf("unknown profile %q", *profile)
	}

	start := time.Now()
	origin := filepath.Join(*out, "origin.git")
	run("", "git", "init", "-q", "--bare", "--initial-branch=main", origin)
	cmd := exec.Command("git", "-C", origin, "fast-import", "--quiet")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		log.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Fatal(err)
	}
	s := newStream(stdin)
	generate(s, *scale)
	s.flush()
	stdin.Close()
	if err := cmd.Wait(); err != nil {
		log.Fatalf("fast-import: %v", err)
	}

	run("", "git", "clone", "-q", origin, filepath.Join(*out, "repo"))
	log.Printf("generated %d commits in %s: %s", s.mark, time.Since(start).Round(time.Second), filepath.Join(*out, "repo"))
}

func run(dir string, name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("%s %v: %v", name, args, err)
	}
}

// stream writes a fast-import stream. Files live three directories deep so
// each commit rewrites only small trees, which keeps generation fast.
type stream struct {
	w     *bufio.Writer
	rng   *rand.Rand
	mark  int
	clock time.Time
	end   time.Time
	step  time.Duration
}

func newStream(w io.Writer) *stream {
	return &stream{w: bufio.NewWriterSize(w, 4<<20), rng: rand.New(rand.NewPCG(1, 2))}
}

func (s *stream) flush() {
	if err := s.w.Flush(); err != nil {
		log.Fatal(err)
	}
}

// spanTime spreads the given number of commits evenly over a period ending
// now.
func (s *stream) spanTime(period time.Duration, commits int) {
	s.end = time.Now()
	s.clock = s.end.Add(-period)
	s.step = period / time.Duration(max(commits, 1))
}

func (s *stream) now() time.Time { return s.clock }

func (s *stream) tick() {
	jitter := time.Duration(s.rng.Int64N(int64(s.step) + 1))
	s.clock = s.clock.Add(s.step/2 + jitter)
}

func filePath(n int) string {
	return fmt.Sprintf("src/m%02d/p%02d/f%03d.txt", n/400, n/20%20, n)
}

// change is a file written by a commit.
type change struct {
	path    string
	content []byte
}

func (s *stream) textChange(files int) change {
	return change{path: filePath(s.rng.IntN(files)), content: s.text(1024 + s.rng.IntN(6*1024))}
}

var words = []string{
	"session", "provider", "message", "render", "config", "token", "stream", "handler",
	"server", "client", "tool", "agent", "prompt", "cache", "layout", "theme", "error",
	"result", "request", "context", "value", "index", "update", "worker", "event",
}

func (s *stream) text(size int) []byte {
	b := make([]byte, 0, size+16)
	for len(b) < size {
		b = append(b, words[s.rng.IntN(len(words))]...)
		if s.rng.IntN(8) == 0 {
			b = append(b, '\n')
		} else {
			b = append(b, ' ')
		}
	}
	return b
}

func (s *stream) binary(size int) []byte {
	b := make([]byte, size)
	for i := range b {
		b[i] = byte(s.rng.Uint32())
	}
	return b
}

// commit writes a commit to ref and returns its mark. parents are marks;
// the first is the parent whose tree is modified.
func (s *stream) commit(ref, message string, parents []int, changes []change) int {
	s.mark++
	s.tick()
	who := fmt.Sprintf("dev%d", s.rng.IntN(150))
	ident := fmt.Sprintf("%s <%s@example.com> %d +0000", who, who, s.now().Unix())
	fmt.Fprintf(s.w, "commit %s\nmark :%d\nauthor %s\ncommitter %s\ndata %d\n%s\n", ref, s.mark, ident, ident, len(message), message)
	for i, parent := range parents {
		if i == 0 {
			fmt.Fprintf(s.w, "from :%d\n", parent)
		} else {
			fmt.Fprintf(s.w, "merge :%d\n", parent)
		}
	}
	for _, c := range changes {
		fmt.Fprintf(s.w, "M 100644 inline %s\ndata %d\n", c.path, len(c.content))
		s.w.Write(c.content)
		s.w.WriteByte('\n')
	}
	return s.mark
}

// reset points ref at a mark, creating it if needed.
func (s *stream) reset(ref string, mark int) {
	fmt.Fprintf(s.w, "reset %s\nfrom :%d\n\n", ref, mark)
}

func scaled(n int, scale float64) int {
	return max(int(float64(n)*scale), 1)
}

func busyBranches(s *stream, scale float64) {
	const files = 7800
	trunkCommits := scaled(15000, scale)
	branchTarget := scaled(1900, scale)
	integrationLines := 3
	tagEvery := 14
	binaryEvery := 25
	binarySize := 300 * 1024
	maxActive := 70

	s.spanTime(18*30*24*time.Hour, trunkCommits+scaled(14500, scale))

	initial := make([]change, files)
	for i := range initial {
		initial[i] = change{path: filePath(i), content: s.text(1024 + s.rng.IntN(3*1024))}
	}
	trunk := s.commit("refs/heads/main", "Initial commit", nil, initial)

	type branch struct {
		name    string
		tip     int
		base    int // -1 for trunk, otherwise an integration line
		left    int
		touched bool
	}
	integration := make([]int, 0, integrationLines)
	var active []*branch
	branches, trunkCount := 0, 1

	edit := func() []change {
		changes := []change{s.textChange(files)}
		for s.rng.IntN(2) == 0 && len(changes) < 4 {
			changes = append(changes, s.textChange(files))
		}
		if s.mark%binaryEvery == 0 {
			changes = append(changes, change{path: fmt.Sprintf("assets/a%04d.bin", s.rng.IntN(400)), content: s.binary(binarySize)})
		}
		return changes
	}
	baseTip := func(b *branch) int {
		if b.base < 0 {
			return trunk
		}
		return integration[b.base]
	}

	for trunkCount < trunkCommits {
		progress := float64(trunkCount) / float64(trunkCommits)

		// Integration lines appear a third of the way in and move steadily.
		if progress > 0.33 && len(integration) < integrationLines && s.rng.IntN(200) == 0 {
			integration = append(integration, trunk)
		}
		for i := range integration {
			ref := fmt.Sprintf("refs/heads/next-%d", i)
			switch {
			case s.rng.IntN(300) == 0:
				integration[i] = s.commit(ref, "Merge main into next", []int{integration[i], trunk}, nil)
			case s.rng.IntN(12) == 0:
				integration[i] = s.commit(ref, "Work on next", []int{integration[i]}, edit())
			}
		}

		// Branch creation accelerates over time, as in a growing project.
		if branches < branchTarget && len(active) < maxActive && s.rng.Float64() < 0.02+0.2*progress*progress {
			b := &branch{name: fmt.Sprintf("refs/heads/%s/%d", []string{"fix", "feat", "refactor", "test", "dev"}[s.rng.IntN(5)], branches), base: -1, left: 1 + s.rng.IntN(9)}
			if len(integration) > 0 && s.rng.IntN(100) < 55 {
				b.base = s.rng.IntN(len(integration))
			}
			b.tip = baseTip(b)
			active = append(active, b)
			branches++
		}

		if len(active) > 0 && s.rng.IntN(3) > 0 {
			i := s.rng.IntN(len(active))
			b := active[i]
			if b.touched && s.rng.IntN(25) == 0 {
				b.tip = s.commit(b.name, "Merge main into branch", []int{b.tip, baseTip(b)}, nil)
			} else {
				b.tip = s.commit(b.name, "Work in progress", []int{b.tip}, edit())
				b.touched = true
				b.left--
			}
			if b.left <= 0 {
				active = append(active[:i], active[i+1:]...)
				if b.base < 0 && s.rng.IntN(10) < 7 {
					trunk = s.commit("refs/heads/main", "Squash merge "+b.name, []int{trunk}, edit())
					trunkCount++
				}
			}
			continue
		}

		trunk = s.commit("refs/heads/main", "Direct change on main", []int{trunk}, edit())
		trunkCount++
		if trunkCount%tagEvery == 0 {
			s.reset(fmt.Sprintf("refs/tags/v1.%d.%d", trunkCount/1000, trunkCount%1000), trunk)
		}
	}
	for _, b := range active {
		s.reset(b.name, b.tip)
	}
}

func deepHistory(s *stream, scale float64) {
	const files = 2000
	commits := scaled(1_300_000, scale)
	s.spanTime(15*365*24*time.Hour, commits)
	initial := make([]change, files)
	for i := range initial {
		initial[i] = change{path: filePath(i), content: []byte(fmt.Sprintf("%d\n", i))}
	}
	trunk := s.commit("refs/heads/main", "Initial commit", nil, initial)
	tips := make([]int, 30)
	for i := range tips {
		tips[i] = trunk
	}
	small := func() []change {
		return []change{{path: filePath(s.rng.IntN(files)), content: []byte(fmt.Sprintf("%d\n", s.mark))}}
	}
	for s.mark < commits {
		slot := s.rng.IntN(len(tips))
		branch := fmt.Sprintf("refs/heads/feature-%d", slot)
		switch roll := s.rng.IntN(10); {
		case roll < 6:
			tips[slot] = s.commit(branch, "Work on "+branch, []int{tips[slot]}, small())
		case roll < 8 && tips[slot] != trunk:
			trunk = s.commit("refs/heads/main", "Merge "+branch, []int{trunk, tips[slot]}, nil)
			tips[slot] = s.commit(branch, "Start "+branch, []int{trunk}, small())
		default:
			trunk = s.commit("refs/heads/main", "Fix on main", []int{trunk}, small())
		}
	}
}
