package repo

import (
	"context"
	"slices"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// ListRemotes returns the configured remotes, ordered by name.
func ListRemotes(ctx context.Context, git *gitexec.Git, loc Location) ([]model.Remote, error) {
	out, err := git.Run(ctx, loc.WorkDir, "config", "-z", "--get-regexp", `^remote\..*\.(url|pushurl)$`)
	if gitexec.ExitCode(err) == 1 {
		return nil, nil // no remotes configured
	}
	if err != nil {
		return nil, err
	}
	byName := map[string]*model.Remote{}
	for _, entry := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
		key, value, _ := strings.Cut(entry, "\n")
		name, field, ok := splitRemoteKey(key)
		if !ok {
			continue
		}
		remote := byName[name]
		if remote == nil {
			remote = &model.Remote{ID: RemoteIDFor(loc.ID, name), RepoID: loc.ID, Name: name, FetchState: model.FetchStateIdle}
			byName[name] = remote
		}
		if field == "url" {
			remote.FetchURL = value
		} else {
			remote.PushURL = value
		}
	}
	remotes := make([]model.Remote, 0, len(byName))
	for _, remote := range byName {
		if remote.PushURL == "" {
			remote.PushURL = remote.FetchURL
		}
		remotes = append(remotes, *remote)
	}
	slices.SortFunc(remotes, func(a, b model.Remote) int { return strings.Compare(a.Name, b.Name) })
	return remotes, nil
}

// splitRemoteKey splits "remote.<name>.<field>"; the name may contain dots.
func splitRemoteKey(key string) (name, field string, ok bool) {
	rest, ok := strings.CutPrefix(key, "remote.")
	if !ok {
		return "", "", false
	}
	dot := strings.LastIndex(rest, ".")
	if dot < 0 {
		return "", "", false
	}
	return rest[:dot], rest[dot+1:], true
}
