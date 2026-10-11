package repo

import (
	"context"
	"fmt"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// ReadStatus returns the changed files of a worktree and their totals.
func ReadStatus(ctx context.Context, git *gitexec.Git, worktreeID model.WorktreeID, path string) ([]model.FileStatus, model.StatusSummary, error) {
	out, err := git.Run(ctx, path, "status", "--porcelain=v2", "-z")
	if err != nil {
		return nil, model.StatusSummary{}, err
	}
	return parseStatus(worktreeID, string(out))
}

func parseStatus(worktreeID model.WorktreeID, out string) ([]model.FileStatus, model.StatusSummary, error) {
	var files []model.FileStatus
	var summary model.StatusSummary
	entries := strings.Split(strings.TrimRight(out, "\x00"), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if entry == "" {
			continue
		}
		file := model.FileStatus{WorktreeID: worktreeID}
		switch entry[0] {
		case '1':
			fields := strings.SplitN(entry, " ", 9)
			if len(fields) != 9 {
				return nil, summary, fmt.Errorf("unexpected status entry %q", entry)
			}
			file.Path = fields[8]
			file.Index, file.WorkTree = statusCode(fields[1][0]), statusCode(fields[1][1])
		case '2':
			fields := strings.SplitN(entry, " ", 10)
			if len(fields) != 10 || i+1 >= len(entries) {
				return nil, summary, fmt.Errorf("unexpected status entry %q", entry)
			}
			file.Path = fields[9]
			file.Index, file.WorkTree = statusCode(fields[1][0]), statusCode(fields[1][1])
			i++
			file.OldPath = entries[i]
		case 'u':
			fields := strings.SplitN(entry, " ", 11)
			if len(fields) != 11 {
				return nil, summary, fmt.Errorf("unexpected status entry %q", entry)
			}
			file.Path = fields[10]
			file.Index, file.WorkTree = model.StatusCodeUnmerged, model.StatusCodeUnmerged
			file.Conflict = fields[1]
		case '?':
			file.Path = entry[2:]
			file.Index, file.WorkTree = model.StatusCodeUntracked, model.StatusCodeUntracked
		default:
			continue
		}
		file.ID = string(worktreeID) + ":" + file.Path
		countStatus(&summary, file)
		files = append(files, file)
	}
	return files, summary, nil
}

func countStatus(summary *model.StatusSummary, file model.FileStatus) {
	switch {
	case file.Index == model.StatusCodeUnmerged:
		summary.Conflicted++
	case file.Index == model.StatusCodeUntracked:
		summary.Untracked++
	default:
		if file.Index != model.StatusCodeUnmodified {
			summary.Staged++
		}
		if file.WorkTree != model.StatusCodeUnmodified {
			summary.Unstaged++
		}
	}
}

func statusCode(c byte) model.StatusCode {
	switch c {
	case 'M':
		return model.StatusCodeModified
	case 'T':
		return model.StatusCodeTypeChanged
	case 'A':
		return model.StatusCodeAdded
	case 'D':
		return model.StatusCodeDeleted
	case 'R':
		return model.StatusCodeRenamed
	case 'C':
		return model.StatusCodeCopied
	case 'U':
		return model.StatusCodeUnmerged
	}
	return model.StatusCodeUnmodified
}
