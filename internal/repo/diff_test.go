package repo_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jyecusch/forkit/internal/model"
	"github.com/jyecusch/forkit/internal/repo"
)

// lines renders a diff compactly: "+3 text" for an added line numbered 3 in
// the new file, "-2 text" for a removal, " 2:3 text" for context.
func lines(diff model.FileDiff) []string {
	var out []string
	for _, hunk := range diff.Hunks {
		for _, l := range hunk.Lines {
			switch l.Kind {
			case model.DiffLineKindAdded:
				out = append(out, fmt.Sprintf("+%d %s", *l.NewLine, l.Text))
			case model.DiffLineKindRemoved:
				out = append(out, fmt.Sprintf("-%d %s", *l.OldLine, l.Text))
			default:
				out = append(out, fmt.Sprintf(" %d:%d %s", *l.OldLine, *l.NewLine, l.Text))
			}
		}
	}
	return out
}

func TestDiffOfACommitAgainstItsParent(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("a.txt", "one\ntwo\nthree\n")
	fixture.Git("add", "a.txt")
	root := fixture.Commit("add a")
	fixture.WriteFile("a.txt", "one\n2\nthree\n")
	fixture.Git("add", "a.txt")
	change := fixture.Commit("change a")

	diff, err := repo.ReadDiff(ctx, git, loc, loc.WorkDir, model.DiffRequest{Kind: model.DiffKindCommit, OID: model.OID(change), Path: "a.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(lines(diff), "|"), " 1:1 one|-2 two|+2 2| 3:3 three"; got != want {
		t.Errorf("lines = %q, want %q", got, want)
	}

	// The parent here is an empty commit, so the file is new in "add a".
	diff, err = repo.ReadDiff(ctx, git, loc, loc.WorkDir, model.DiffRequest{Kind: model.DiffKindCommit, OID: model.OID(root), Path: "a.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(lines(diff)); got != 3 || diff.Hunks[0].OldStart != 0 {
		t.Errorf("new file diff = %+v", diff)
	}
}

func TestDiffOfTheRootCommit(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	// Fold a file into the fixture's first commit, so it has one to show.
	fixture.WriteFile("b.txt", "b\n")
	fixture.Git("add", "b.txt")
	fixture.Git("commit", "-q", "--amend", "-m", "root with a file")
	first := fixture.Git("rev-parse", "HEAD")

	diff, err := repo.ReadDiff(ctx, git, loc, loc.WorkDir, model.DiffRequest{Kind: model.DiffKindCommit, OID: model.OID(first), Path: "b.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(lines(diff), "|"); got != "+1 b" {
		t.Errorf("lines = %q", got)
	}
}

func TestDiffOfWorktreeChanges(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("c.txt", "c\n")
	fixture.Git("add", "c.txt")
	fixture.Commit("add c")

	fixture.WriteFile("c.txt", "staged\n")
	fixture.Git("add", "c.txt")
	fixture.WriteFile("c.txt", "unstaged")
	fixture.WriteFile("new.txt", "brand new\n")

	cases := []struct {
		kind model.DiffKind
		path string
		want string
	}{
		{model.DiffKindStaged, "c.txt", "-1 c|+1 staged"},
		{model.DiffKindUnstaged, "c.txt", "-1 staged|+1 unstaged"},
		{model.DiffKindUntracked, "new.txt", "+1 brand new"},
	}
	for _, c := range cases {
		diff, err := repo.ReadDiff(ctx, git, loc, fixture.Dir, model.DiffRequest{Kind: c.kind, Path: c.path})
		if err != nil {
			t.Fatalf("%s: %v", c.kind, err)
		}
		if got := strings.Join(lines(diff), "|"); got != c.want {
			t.Errorf("%s: lines = %q, want %q", c.kind, got, c.want)
		}
	}

	unstaged, _ := repo.ReadDiff(ctx, git, loc, fixture.Dir, model.DiffRequest{Kind: model.DiffKindUnstaged, Path: "c.txt"})
	if last := unstaged.Hunks[0].Lines[1]; last.NoNewline == nil || !*last.NoNewline {
		t.Errorf("missing final newline not marked on %+v", last)
	}
}

func TestDiffShowsTheWholeFile(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("long.txt", strings.Repeat("same\n", 30)+"old\n"+strings.Repeat("same\n", 30))
	fixture.Git("add", "long.txt")
	fixture.Commit("add long")
	fixture.WriteFile("long.txt", strings.Repeat("same\n", 30)+"new\n"+strings.Repeat("same\n", 30))

	diff, err := repo.ReadDiff(ctx, git, loc, fixture.Dir, model.DiffRequest{Kind: model.DiffKindUnstaged, Path: "long.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if len(diff.Hunks) != 1 || len(lines(diff)) != 62 {
		t.Errorf("got %d hunks and %d lines, want the whole file in one hunk", len(diff.Hunks), len(lines(diff)))
	}
}

func TestDiffFollowsARename(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("old.txt", "one\ntwo\nthree\nfour\nfive\n")
	fixture.Git("add", "old.txt")
	fixture.Commit("add old")
	fixture.Git("mv", "old.txt", "new.txt")
	fixture.WriteFile("new.txt", "one\ntwo\nthree\nfour\nFIVE\n")
	fixture.Git("add", "new.txt")
	renamed := fixture.Commit("rename")

	diff, err := repo.ReadDiff(ctx, git, loc, loc.WorkDir, model.DiffRequest{Kind: model.DiffKindCommit, OID: model.OID(renamed), Path: "new.txt", OldPath: "old.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(lines(diff), "|"); !strings.HasSuffix(got, "-5 five|+5 FIVE") || strings.Contains(got, "+1 one") {
		t.Errorf("rename was not paired: %q", got)
	}
}

func TestDiffOfABinaryFile(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("image.bin", "\x00\x01\x02binary")

	diff, err := repo.ReadDiff(ctx, git, loc, fixture.Dir, model.DiffRequest{Kind: model.DiffKindUntracked, Path: "image.bin"})
	if err != nil {
		t.Fatal(err)
	}
	if !diff.Binary || len(diff.Hunks) != 0 {
		t.Errorf("diff = %+v, want binary with no hunks", diff)
	}
}

func TestDiffStopsAtTheLineLimit(t *testing.T) {
	ctx := context.Background()
	git, fixture, loc := setup(t)
	fixture.WriteFile("huge.txt", strings.Repeat("line\n", 55_000))

	diff, err := repo.ReadDiff(ctx, git, loc, fixture.Dir, model.DiffRequest{Kind: model.DiffKindUntracked, Path: "huge.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if !diff.Truncated || len(lines(diff)) != 50_000 {
		t.Errorf("truncated = %v with %d lines", diff.Truncated, len(lines(diff)))
	}
}
