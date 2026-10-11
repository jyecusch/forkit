package repo

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

var refFields = []string{
	"%(refname)", "%(objectname)", "%(*objectname)", "%(upstream)",
	"%(upstream:track,nobracket)", "%(worktreepath)", "%(symref)",
	"%(objecttype)", "%(*objecttype)",
}

// ListRefs returns local and remote branches, tags and stashes. remotes is
// needed to split remote branch names, since remote names may contain "/".
func ListRefs(ctx context.Context, git *gitexec.Git, loc Location, remotes []model.Remote) ([]model.Ref, error) {
	out, err := git.Run(ctx, loc.WorkDir, "for-each-ref",
		"--format="+strings.Join(refFields, "%00"),
		"refs/heads", "refs/remotes", "refs/tags")
	if err != nil {
		return nil, err
	}
	var refs []model.Ref
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		ref, ok, err := parseRefLine(loc.ID, line, remotes)
		if err != nil {
			return nil, err
		}
		if ok {
			refs = append(refs, ref)
		}
	}
	stashes, err := listStashes(ctx, git, loc)
	if err != nil {
		return nil, err
	}
	return append(refs, stashes...), nil
}

func parseRefLine(repoID model.RepoID, line string, remotes []model.Remote) (ref model.Ref, ok bool, err error) {
	fields := strings.Split(line, "\x00")
	if len(fields) != len(refFields) {
		return model.Ref{}, false, fmt.Errorf("unexpected for-each-ref line %q", line)
	}
	fullName, target, peeled, upstream, track, worktreePath, symref, objectType, peeledType :=
		fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], fields[7], fields[8]
	if symref != "" {
		return model.Ref{}, false, nil // e.g. refs/remotes/origin/HEAD
	}
	if objectType != "commit" && peeledType != "commit" {
		return model.Ref{}, false, nil // a tag of a tree or blob has no place in history
	}
	ref = model.Ref{
		ID:        RefIDFor(repoID, fullName),
		RepoID:    repoID,
		FullName:  fullName,
		TargetOID: model.OID(target),
	}
	switch {
	case strings.HasPrefix(fullName, "refs/heads/"):
		ref.Kind = model.RefKindLocalBranch
		ref.ShortName = strings.TrimPrefix(fullName, "refs/heads/")
	case strings.HasPrefix(fullName, "refs/remotes/"):
		ref.Kind = model.RefKindRemoteBranch
		ref.ShortName = strings.TrimPrefix(fullName, "refs/remotes/")
		if remote, found := remoteOwning(ref.ShortName, remotes); found {
			ref.RemoteID = remote.ID
		}
	default:
		ref.Kind = model.RefKindTag
		ref.ShortName = strings.TrimPrefix(fullName, "refs/tags/")
	}
	if peeled != "" {
		ref.PeeledOID = model.OID(peeled)
	}
	if upstream != "" {
		ref.UpstreamRefID = RefIDFor(repoID, upstream)
		ahead, behind := parseTrack(track)
		ref.Ahead, ref.Behind = &ahead, &behind
	}
	if worktreePath != "" {
		ref.CheckedOutInWorktreeID = WorktreeIDFor(worktreePath)
	}
	return ref, true, nil
}

// remoteOwning finds the remote a remote-tracking branch such as
// "origin/feature/x" belongs to, preferring the longest matching name.
func remoteOwning(shortName string, remotes []model.Remote) (model.Remote, bool) {
	var best model.Remote
	found := false
	for _, remote := range remotes {
		if strings.HasPrefix(shortName, remote.Name+"/") && len(remote.Name) > len(best.Name) {
			best, found = remote, true
		}
	}
	return best, found
}

// parseTrack parses %(upstream:track,nobracket), e.g. "ahead 1, behind 2".
func parseTrack(track string) (ahead, behind int) {
	for _, part := range strings.Split(track, ", ") {
		label, count, _ := strings.Cut(part, " ")
		n, _ := strconv.Atoi(count)
		switch label {
		case "ahead":
			ahead = n
		case "behind":
			behind = n
		}
	}
	return ahead, behind
}

func listStashes(ctx context.Context, git *gitexec.Git, loc Location) ([]model.Ref, error) {
	if loc.IsBare {
		return nil, nil
	}
	out, err := git.Run(ctx, loc.WorkDir, "stash", "list", "--format=%H %gd")
	if err != nil {
		return nil, err
	}
	var stashes []model.Ref
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		oid, name, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		stashes = append(stashes, model.Ref{
			ID:        RefIDFor(loc.ID, name),
			RepoID:    loc.ID,
			FullName:  name,
			ShortName: name,
			Kind:      model.RefKindStash,
			TargetOID: model.OID(oid),
		})
	}
	return stashes, nil
}

// DefaultBranch names the branch the repository considers primary: the one
// origin's HEAD points at, otherwise the main worktree's branch.
func DefaultBranch(ctx context.Context, git *gitexec.Git, loc Location) (string, error) {
	out, err := git.Run(ctx, loc.WorkDir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")
	if err == nil {
		return strings.TrimPrefix(strings.TrimSpace(string(out)), "origin/"), nil
	}
	if gitexec.ExitCode(err) != 1 {
		return "", err
	}
	out, err = git.Run(ctx, loc.WorkDir, "symbolic-ref", "-q", "--short", "HEAD")
	if gitexec.ExitCode(err) == 1 {
		return "", nil // detached HEAD
	}
	return strings.TrimSpace(string(out)), err
}
