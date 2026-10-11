package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

const zeroOID = "0000000000000000000000000000000000000000"

// WorktreeInfo is a worktree plus where its private git dir lives.
type WorktreeInfo struct {
	model.Worktree
	GitDir string
}

// ListWorktrees returns every worktree of the repository. Status summaries
// are left zero; fill them in with ReadStatus.
func ListWorktrees(ctx context.Context, git *gitexec.Git, loc Location) ([]WorktreeInfo, error) {
	out, err := git.Run(ctx, loc.CommonDir, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	var worktrees []WorktreeInfo
	for i, record := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00\x00") {
		wt, isBareEntry := parseWorktreeRecord(loc.ID, record)
		if isBareEntry {
			continue
		}
		wt.IsMain = i == 0
		wt.GitDir = worktreeGitDir(loc.CommonDir, wt)
		wt.Operation = detectOperation(wt.GitDir)
		worktrees = append(worktrees, wt)
	}
	return worktrees, nil
}

// parseWorktreeRecord parses one worktree list entry. isBareEntry is true for
// the entry a bare repository lists for itself, which is not a worktree.
func parseWorktreeRecord(repoID model.RepoID, record string) (wt WorktreeInfo, isBareEntry bool) {
	wt = WorktreeInfo{Worktree: model.Worktree{
		RepoID:    repoID,
		Head:      model.WorktreeHead{Kind: model.HeadKindDetached},
		Operation: model.WorktreeOperationNone,
	}}
	for _, field := range strings.Split(record, "\x00") {
		key, value, _ := strings.Cut(field, " ")
		switch key {
		case "worktree":
			wt.Path = value
			wt.ID = WorktreeIDFor(value)
		case "HEAD":
			wt.Head.OID = model.OID(value)
		case "branch":
			wt.Head.Kind = model.HeadKindBranch
			wt.Head.RefID = RefIDFor(repoID, value)
		case "locked":
			wt.Locked = true
		case "prunable":
			wt.Prunable = true
		case "bare":
			isBareEntry = true
		}
	}
	if wt.Head.OID == zeroOID {
		wt.Head.Kind = model.HeadKindUnborn
	}
	return wt, isBareEntry
}

// worktreeGitDir finds a worktree's private git dir: the common dir for the
// main worktree, otherwise the directory named by its .git file.
func worktreeGitDir(commonDir string, wt WorktreeInfo) string {
	if wt.IsMain {
		return commonDir
	}
	content, err := os.ReadFile(filepath.Join(wt.Path, ".git"))
	if err != nil {
		return ""
	}
	dir, ok := strings.CutPrefix(strings.TrimSpace(string(content)), "gitdir: ")
	if !ok {
		return ""
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(wt.Path, dir)
	}
	return filepath.Clean(dir)
}

// operationMarkers maps files git leaves in a worktree's git dir while an
// operation is in progress to that operation. Rebase is checked first because
// a conflicted rebase can also leave CHERRY_PICK_HEAD behind.
var operationMarkers = []struct {
	path      string
	operation model.WorktreeOperation
}{
	{"rebase-merge", model.WorktreeOperationRebase},
	{"rebase-apply", model.WorktreeOperationRebase},
	{"MERGE_HEAD", model.WorktreeOperationMerge},
	{"CHERRY_PICK_HEAD", model.WorktreeOperationCherryPick},
	{"REVERT_HEAD", model.WorktreeOperationRevert},
	{"BISECT_LOG", model.WorktreeOperationBisect},
}

func detectOperation(gitDir string) model.WorktreeOperation {
	if gitDir == "" {
		return model.WorktreeOperationNone
	}
	for _, marker := range operationMarkers {
		if _, err := os.Stat(filepath.Join(gitDir, marker.path)); err == nil {
			return marker.operation
		}
	}
	return model.WorktreeOperationNone
}
