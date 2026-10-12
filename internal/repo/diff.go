package repo

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strconv"
	"strings"

	"github.com/jyecusch/forkit/internal/apperr"
	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// maxDiffLines bounds the lines read for one file, which is shown whole. A
// longer file is reported as truncated rather than shipped to the window.
const maxDiffLines = 50_000

// errDiffFull stops reading once maxDiffLines is reached.
var errDiffFull = errors.New("diff line limit reached")

// diffFlags keep the output plain unified diff, whatever the user's config,
// with the whole file as context so changes are seen where they sit.
var diffFlags = []string{"--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M", "--unified=1000000000"}

// ReadDiff returns one file, whole, with its changes marked: in a commit,
// against its first parent; or in a worktree, staged, unstaged or
// untracked. dir is the worktree for a worktree diff and the repository's
// work dir otherwise.
func ReadDiff(ctx context.Context, git *gitexec.Git, loc Location, dir string, req model.DiffRequest) (model.FileDiff, error) {
	args, err := diffArgs(ctx, git, loc, req)
	if err != nil {
		return model.FileDiff{}, err
	}
	diff := model.FileDiff{Path: req.Path, OldPath: req.OldPath}
	err = git.Repo(loc.CommonDir, dir).Stream(ctx, nil, func(out io.Reader) error {
		return parseDiff(out, &diff)
	}, args...)
	switch {
	case errors.Is(err, errDiffFull):
		diff.Truncated = true
	case req.Kind == model.DiffKindUntracked && gitexec.ExitCode(err) == 1:
		// --no-index exits with 1 when the files differ, which they always do.
	case err != nil:
		return model.FileDiff{}, err
	}
	return diff, nil
}

func diffArgs(ctx context.Context, git *gitexec.Git, loc Location, req model.DiffRequest) ([]string, error) {
	paths := []string{"--", req.Path}
	if req.OldPath != "" {
		// Both sides of a rename, so git can pair them.
		paths = append(paths, req.OldPath)
	}
	switch req.Kind {
	case model.DiffKindCommit:
		parents, err := git.Run(ctx, loc.WorkDir, "rev-list", "--parents", "-n1", string(req.OID), "--")
		if err != nil {
			return nil, err
		}
		args := append([]string{"diff-tree", "-p", "-r"}, diffFlags...)
		if fields := strings.Fields(string(parents)); len(fields) > 1 {
			args = append(args, fields[1], fields[0])
		} else {
			args = append(args, "--root", string(req.OID))
		}
		return append(args, paths...), nil
	case model.DiffKindStaged:
		return append(append([]string{"diff", "--cached"}, diffFlags...), paths...), nil
	case model.DiffKindUnstaged:
		return append(append([]string{"diff"}, diffFlags...), paths...), nil
	case model.DiffKindUntracked:
		return append(append([]string{"diff", "--no-index"}, diffFlags...), "--", "/dev/null", req.Path), nil
	}
	return nil, apperr.New(model.ErrorCodeInvalidArgument, "unknown diff kind")
}

// parseDiff reads one file's unified diff into hunks, stopping with
// errDiffFull at maxDiffLines.
func parseDiff(out io.Reader, diff *model.FileDiff) error {
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var hunk *model.DiffHunk
	var oldLine, newLine, lines int
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "@@ ") {
			parsed, ok := parseHunkHeader(line)
			if !ok {
				continue
			}
			diff.Hunks = append(diff.Hunks, parsed)
			hunk = &diff.Hunks[len(diff.Hunks)-1]
			oldLine, newLine = parsed.OldStart, parsed.NewStart
			continue
		}
		if hunk == nil {
			// File header lines, before the first hunk.
			if strings.HasPrefix(line, "Binary files ") || strings.HasPrefix(line, "GIT binary patch") {
				diff.Binary = true
			}
			continue
		}
		if line == `\ No newline at end of file` {
			if n := len(hunk.Lines); n > 0 {
				hunk.Lines[n-1].NoNewline = ptr(true)
			}
			continue
		}
		if lines == maxDiffLines {
			return errDiffFull
		}
		entry := model.DiffLine{}
		switch {
		case strings.HasPrefix(line, "+"):
			entry = model.DiffLine{Kind: model.DiffLineKindAdded, NewLine: ptr(newLine), Text: line[1:]}
			newLine++
		case strings.HasPrefix(line, "-"):
			entry = model.DiffLine{Kind: model.DiffLineKindRemoved, OldLine: ptr(oldLine), Text: line[1:]}
			oldLine++
		case strings.HasPrefix(line, " ") || line == "":
			entry = model.DiffLine{Kind: model.DiffLineKindContext, OldLine: ptr(oldLine), NewLine: ptr(newLine), Text: strings.TrimPrefix(line, " ")}
			oldLine++
			newLine++
		default:
			// The next file's header; one file is asked for, so this is the end.
			hunk = nil
			continue
		}
		hunk.Lines = append(hunk.Lines, entry)
		lines++
	}
	return scanner.Err()
}

// parseHunkHeader reads "@@ -a,b +c,d @@ section", where a missing count
// means 1.
func parseHunkHeader(line string) (model.DiffHunk, bool) {
	rest := strings.TrimPrefix(line, "@@ ")
	ranges, section, ok := strings.Cut(rest, " @@")
	if !ok {
		return model.DiffHunk{}, false
	}
	oldRange, newRange, ok := strings.Cut(ranges, " ")
	if !ok || !strings.HasPrefix(oldRange, "-") || !strings.HasPrefix(newRange, "+") {
		return model.DiffHunk{}, false
	}
	oldStart, oldLines, ok1 := parseRange(oldRange[1:])
	newStart, newLines, ok2 := parseRange(newRange[1:])
	if !ok1 || !ok2 {
		return model.DiffHunk{}, false
	}
	return model.DiffHunk{
		OldStart: oldStart, OldLines: oldLines,
		NewStart: newStart, NewLines: newLines,
		Section: strings.TrimSpace(section),
	}, true
}

func parseRange(r string) (start, count int, ok bool) {
	startText, countText, hasCount := strings.Cut(r, ",")
	start, err := strconv.Atoi(startText)
	if err != nil {
		return 0, 0, false
	}
	if !hasCount {
		return start, 1, true
	}
	count, err = strconv.Atoi(countText)
	return start, count, err == nil
}

func ptr[T any](v T) *T { return &v }
