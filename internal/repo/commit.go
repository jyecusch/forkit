package repo

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

const commitDetailFormat = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B"

// ReadCommitDetail returns a commit's full message and the files it changed
// relative to its first parent.
func ReadCommitDetail(ctx context.Context, git *gitexec.Git, loc Location, oid model.OID) (model.CommitDetail, error) {
	out, err := git.Run(ctx, loc.WorkDir, "show", "-s", "--format="+commitDetailFormat, string(oid), "--")
	if err != nil {
		return model.CommitDetail{}, err
	}
	detail, err := parseCommitDetail(string(out))
	if err != nil {
		return model.CommitDetail{}, err
	}

	args := []string{"diff-tree", "-r", "-z", "-M", "--raw", "--numstat", "--no-commit-id"}
	if len(detail.Parents) == 0 {
		args = append(args, "--root", string(oid))
	} else {
		args = append(args, string(detail.Parents[0]), string(oid))
	}
	out, err = git.Run(ctx, loc.WorkDir, args...)
	if err != nil {
		return model.CommitDetail{}, err
	}
	detail.Files, err = parseFileChanges(string(out))
	return detail, err
}

// ReadStashDetail returns a stash's message and the files it changed
// relative to the commit it was made on, untracked files included. Its only
// parent is that commit, as in the graph.
func ReadStashDetail(ctx context.Context, git *gitexec.Git, loc Location, oid model.OID) (model.CommitDetail, error) {
	detail, err := ReadCommitDetail(ctx, git, loc, oid)
	if err != nil || len(detail.Parents) < 2 {
		return detail, err
	}
	parents := detail.Parents
	detail.Parents = parents[:1]
	if len(parents) < 3 {
		return detail, nil
	}
	// The third parent, made by --include-untracked, is a root commit
	// holding only the untracked files.
	untracked := parents[2]
	out, err := git.Run(ctx, loc.WorkDir, "diff-tree", "-r", "-z", "--raw", "--numstat", "--no-commit-id", "--root", string(untracked))
	if err != nil {
		return model.CommitDetail{}, err
	}
	files, err := parseFileChanges(string(out))
	if err != nil {
		return model.CommitDetail{}, err
	}
	for i := range files {
		files[i].DiffOID = untracked
	}
	detail.Files = append(detail.Files, files...)
	return detail, nil
}

func parseCommitDetail(out string) (model.CommitDetail, error) {
	fields := strings.SplitN(out, "\x00", 9)
	if len(fields) != 9 {
		return model.CommitDetail{}, fmt.Errorf("unexpected commit format %q", out)
	}
	detail := model.CommitDetail{
		OID:            model.OID(fields[0]),
		AuthorName:     fields[2],
		AuthorEmail:    fields[3],
		AuthorTime:     unixSecondsToMillis(fields[4]),
		CommitterName:  fields[5],
		CommitterEmail: fields[6],
		CommitterTime:  unixSecondsToMillis(fields[7]),
		Body:           strings.TrimRight(fields[8], "\n"),
	}
	for _, parent := range strings.Fields(fields[1]) {
		detail.Parents = append(detail.Parents, model.OID(parent))
	}
	return detail, nil
}

func unixSecondsToMillis(s string) model.UnixMillis {
	seconds, _ := strconv.ParseInt(s, 10, 64)
	return model.UnixMillis(seconds * 1000)
}

// parseFileChanges parses "diff-tree -z --raw --numstat", which prints every
// raw entry and then a numstat entry for each file in the same order.
func parseFileChanges(out string) ([]model.FileChange, error) {
	tokens := strings.Split(strings.TrimRight(out, "\x00"), "\x00")
	var changes []model.FileChange
	i := 0
	for ; i < len(tokens) && strings.HasPrefix(tokens[i], ":"); i++ {
		header := strings.Fields(tokens[i])
		status := header[len(header)-1]
		change := model.FileChange{Status: fileChangeStatus(status[0])}
		if status[0] == 'R' || status[0] == 'C' {
			change.OldPath = tokens[i+1]
			i++
		}
		change.Path = tokens[i+1]
		i++
		changes = append(changes, change)
	}
	for n := range changes {
		if i >= len(tokens) {
			return nil, fmt.Errorf("missing numstat for %s", changes[n].Path)
		}
		parts := strings.SplitN(tokens[i], "\t", 3)
		if len(parts) != 3 {
			return nil, fmt.Errorf("unexpected numstat entry %q", tokens[i])
		}
		changes[n].Binary = parts[0] == "-"
		changes[n].Additions, _ = strconv.Atoi(parts[0])
		changes[n].Deletions, _ = strconv.Atoi(parts[1])
		if parts[2] == "" {
			i += 2 // a rename's old and new paths follow as separate tokens
		}
		i++
	}
	return changes, nil
}

func fileChangeStatus(letter byte) model.FileChangeStatus {
	switch letter {
	case 'A':
		return model.FileChangeStatusAdded
	case 'D':
		return model.FileChangeStatusDeleted
	case 'R':
		return model.FileChangeStatusRenamed
	case 'C':
		return model.FileChangeStatusCopied
	case 'T':
		return model.FileChangeStatusTypeChanged
	}
	return model.FileChangeStatusModified
}
