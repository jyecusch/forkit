// Command synthrepo generates large repositories for performance testing.
// They are built locally rather than committed because they run to hundreds
// of megabytes.
//
// Each run writes OUT/origin.git, a bare repository, and OUT/repo, a clone
// of it, so remote-tracking branches and fetches behave as they would
// against a real server. The clone is fetched in stages, so its objects are
// spread over several packs as they are in a clone that has been fetched
// into for a while.
//
// Profiles:
//
//   - busy-branches: a squash-merge workflow over about eighteen months. A
//     mostly linear trunk with frequent lightweight release tags, a few
//     long-lived integration lines, and around 1,900 pushed branches that
//     are never deleted, many of which merge the trunk back in. The history
//     is modest in length but very wide and has thousands of refs, and the
//     pack is inflated by binary assets, a few of them tens of megabytes.
//     Commit messages often have bodies, a thousand people commit, and one
//     directory holds two thousand files. The clone has a JavaScript
//     project's dependencies installed: a quarter of a million ignored files
//     in node_modules directories, which slow down any tool that walks the
//     working tree.
//
//   - deep-history: well over a million commits on a few dozen branches with
//     regular merges, for history walking and layout at scale.
//
//     go run ./tools/synthrepo -profile busy-branches -out test-repos/busy
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	installsDependencies := *profile == "busy-branches"
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

	repo := filepath.Join(*out, "repo")
	run("", "git", "clone", "-q", "--no-local", "--single-branch", "--no-tags", origin, repo)
	run(repo, "git", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	run(repo, "git", "fetch", "-q", "origin")
	run(repo, "git", "fetch", "-q", "--tags", "origin")
	if installsDependencies {
		installDependencies(repo, *scale)
	}
	log.Printf("generated %d commits in %s: %s", s.mark, time.Since(start).Round(time.Second), repo)
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
	w    *bufio.Writer
	rng  *rand.Rand
	mark int
	// authors is how many people commit.
	authors float64
	// bodies is the share of commits whose message has a body.
	bodies float64
	clock  time.Time
	end    time.Time
	step   time.Duration
}

func newStream(w io.Writer) *stream {
	return &stream{w: bufio.NewWriterSize(w, 4<<20), rng: rand.New(rand.NewPCG(1, 2)), authors: 150}
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

// tick advances the clock, never past the end of the period, since the
// number of commits a profile makes is only estimated up front.
func (s *stream) tick() {
	jitter := time.Duration(s.rng.Int64N(int64(s.step) + 1))
	s.clock = s.clock.Add(s.step/2 + jitter)
	if s.clock.After(s.end) {
		s.clock = s.end
	}
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

// withBody adds a body of a few paragraphs to some messages, averaging a
// few hundred bytes and now and then running to several kilobytes.
func (s *stream) withBody(subject string) string {
	if s.rng.Float64() >= s.bodies {
		return subject
	}
	size := 200 + s.rng.IntN(1000)
	if s.rng.IntN(50) == 0 {
		size = 3000 + s.rng.IntN(2000)
	}
	return subject + "\n\n" + string(s.text(size))
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
	// A few people make most of the commits, as in an open-source project.
	who := fmt.Sprintf("dev%d", int(s.authors*math.Pow(s.rng.Float64(), 3)))
	ident := fmt.Sprintf("%s <%s@example.com> %d +0000", who, who, s.now().Unix())
	message = s.withBody(message)
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
	// A generated directory, like snapshots or fixtures, whose tree object
	// is rewritten whole whenever one of its files changes.
	const wideFiles = 2000
	wideEvery := 40
	// Huge assets, such as a bundled binary, added now and then.
	hugeEvery := trunkCommits / 3
	hugeSize := 30 << 20
	s.authors, s.bodies = 1000, 0.6

	s.spanTime(18*30*24*time.Hour, trunkCommits+scaled(14500, scale))

	initial := make([]change, files, files+wideFiles+1)
	for i := range initial {
		initial[i] = change{path: filePath(i), content: s.text(1024 + s.rng.IntN(3*1024))}
	}
	for i := range wideFiles {
		initial = append(initial, change{path: widePath(i), content: s.text(200)})
	}
	initial = append(initial, change{path: ".gitignore", content: []byte("node_modules\ndist\n")})
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
		if s.mark%wideEvery == 0 {
			changes = append(changes, change{path: widePath(s.rng.IntN(wideFiles)), content: s.text(200)})
		}
		if hugeEvery > 0 && s.mark%hugeEvery == 0 {
			changes = append(changes, change{path: "vendor/bundle.bin", content: s.binary(hugeSize)})
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
					trunk = s.commit("refs/heads/main", "Squash merge "+strings.TrimPrefix(b.name, "refs/heads/"), []int{trunk}, edit())
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

func widePath(n int) string {
	return fmt.Sprintf("snapshots/s%04d.json", n)
}

// installDependencies fills node_modules directories, which the repository
// ignores, as installing a JavaScript project's packages would: one at the
// root and one in each of a handful of packages, holding about a quarter of
// a million small files in some forty thousand directories.
func installDependencies(repo string, scale float64) {
	rng := rand.New(rand.NewPCG(3, 4))
	roots := []string{"node_modules"}
	for i := range 8 {
		roots = append(roots, fmt.Sprintf("src/m%02d/node_modules", i))
	}
	packages := scaled(2200, scale)
	for p := range packages {
		root := roots[0]
		if p%3 == 0 {
			root = roots[1+rng.IntN(len(roots)-1)]
		}
		pkg := filepath.Join(repo, root, fmt.Sprintf("@scope%d", p%40), fmt.Sprintf("pkg-%d", p))
		for d := range 14 {
			dir := filepath.Join(pkg, "lib", fmt.Sprintf("d%d", d%5), fmt.Sprintf("e%d", d))
			if err := os.MkdirAll(dir, 0o755); err != nil {
				log.Fatal(err)
			}
			for f := range 8 {
				name := filepath.Join(dir, fmt.Sprintf("f%d.js", f))
				if err := os.WriteFile(name, []byte(fmt.Sprintf("module.exports = %d\n", rng.Int())), 0o644); err != nil {
					log.Fatal(err)
				}
			}
		}
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
