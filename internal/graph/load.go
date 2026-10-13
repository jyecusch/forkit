package graph

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// streamBatchSize is how many commits are parsed before they are handed over,
// small enough that the first screen arrives quickly.
const streamBatchSize = 2000

// logEntry is one commit as listed by git log: its oid and parent oids.
type logEntry struct {
	oid     []byte
	parents [][]byte
	// stash marks a stash, whose only parent is then the commit it was made on.
	stash bool
}

// streamLog lists the commits reachable from include but not from exclude in
// display order, handing them to onBatch in groups as git produces them.
// Stashes, which must be among include to be listed, are trimmed by
// stashTrimmer.
func streamLog(ctx context.Context, repo *gitexec.Repo, order model.GraphOrder, include, exclude, stashes []model.OID, onBatch func([]logEntry) error) error {
	trimmer, err := newStashTrimmer(stashes)
	if err != nil {
		return err
	}
	var revs strings.Builder
	for _, oid := range include {
		fmt.Fprintf(&revs, "%s\n", oid)
	}
	for _, oid := range exclude {
		fmt.Fprintf(&revs, "^%s\n", oid)
	}
	orderFlag := "--topo-order"
	if order == model.GraphOrderDate {
		orderFlag = "--date-order"
	}
	return repo.Stream(ctx, strings.NewReader(revs.String()), func(r io.Reader) error {
		return parseLog(r, func(batch []logEntry) error {
			return onBatch(trimmer.trim(batch))
		})
	}, "log", orderFlag, "--format=%H %P", "--stdin")
}

// stashTrimmer leaves out of a log the commits git makes to hold a stash's
// staged and untracked files, its second and third parents, so a stash
// shows as one row joined only to the commit it was made on. Git lists a
// stash before its parents, so they are known by the time they are reached.
type stashTrimmer struct {
	stashes map[string]bool
	hidden  map[string]bool
}

func newStashTrimmer(stashes []model.OID) (*stashTrimmer, error) {
	t := &stashTrimmer{stashes: map[string]bool{}, hidden: map[string]bool{}}
	for _, oid := range stashes {
		raw, err := hex.DecodeString(string(oid))
		if err != nil {
			return nil, fmt.Errorf("bad stash oid %q: %w", oid, err)
		}
		t.stashes[string(raw)] = true
	}
	return t, nil
}

func (t *stashTrimmer) trim(batch []logEntry) []logEntry {
	if len(t.stashes) == 0 {
		return batch
	}
	kept := batch[:0]
	for _, entry := range batch {
		if t.hidden[string(entry.oid)] {
			delete(t.hidden, string(entry.oid))
			continue
		}
		if t.stashes[string(entry.oid)] && len(entry.parents) > 0 {
			for _, parent := range entry.parents[1:] {
				t.hidden[string(parent)] = true
			}
			entry.parents, entry.stash = entry.parents[:1], true
		}
		kept = append(kept, entry)
	}
	return kept
}

func parseLog(r io.Reader, onBatch func([]logEntry) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	batch := make([]logEntry, 0, streamBatchSize)
	for scanner.Scan() {
		entry, err := parseLogLine(scanner.Bytes())
		if err != nil {
			return err
		}
		batch = append(batch, entry)
		if len(batch) == streamBatchSize {
			if err := onBatch(batch); err != nil {
				return err
			}
			batch = make([]logEntry, 0, streamBatchSize)
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(batch) > 0 {
		return onBatch(batch)
	}
	return nil
}

func parseLogLine(line []byte) (logEntry, error) {
	fields := bytes.Fields(line)
	if len(fields) == 0 {
		return logEntry{}, fmt.Errorf("empty log line")
	}
	decoded := make([][]byte, len(fields))
	for i, field := range fields {
		oid := make([]byte, hex.DecodedLen(len(field)))
		if _, err := hex.Decode(oid, field); err != nil {
			return logEntry{}, fmt.Errorf("bad oid %q: %w", field, err)
		}
		decoded[i] = oid
	}
	return logEntry{oid: decoded[0], parents: decoded[1:]}, nil
}

func appendEntries(h *History, entries []logEntry) error {
	for _, entry := range entries {
		if err := h.Append(entry.oid, entry.parents); err != nil {
			return err
		}
		if entry.stash {
			h.markStash(h.Len() - 1)
		}
	}
	return nil
}

// errListed stops a log walk once leadsWith has seen what it needs.
var errListed = errors.New("listed enough")

// leadsWith reports whether git lists history from tips, in order, as the
// rows of lead followed by next. Commits new since the last walk can then go
// on top of the rows already laid out; otherwise, as when date order puts a
// fetched branch's older commits among them, they cannot. An empty next
// means nothing follows lead. The walk stops early in date order, but not in
// topological order.
func leadsWith(ctx context.Context, repo *gitexec.Repo, order model.GraphOrder, tips, stashes []model.OID, lead *History, next model.OID) (bool, error) {
	want := make([]model.OID, 0, lead.Len()+1)
	for row := range lead.Len() {
		want = append(want, lead.OID(row))
	}
	if next != "" {
		want = append(want, next)
	}
	seen := 0
	agrees := true
	err := streamLog(ctx, repo, order, tips, nil, stashes, func(batch []logEntry) error {
		for _, entry := range batch {
			if seen == len(want) {
				return errListed
			}
			if model.OID(hex.EncodeToString(entry.oid)) != want[seen] {
				agrees = false
				return errListed
			}
			seen++
		}
		return nil
	})
	if err != nil && !errors.Is(err, errListed) {
		return false, err
	}
	return agrees && seen == len(want), nil
}

// allReachable reports whether every commit in tips is reachable from heads,
// meaning history built from heads still contains them.
func allReachable(ctx context.Context, repo *gitexec.Repo, tips, heads []model.OID) (bool, error) {
	var revs strings.Builder
	for _, oid := range tips {
		fmt.Fprintf(&revs, "%s\n", oid)
	}
	for _, oid := range heads {
		fmt.Fprintf(&revs, "^%s\n", oid)
	}
	unreachable := false
	err := repo.Stream(ctx, strings.NewReader(revs.String()), func(r io.Reader) error {
		out, err := io.ReadAll(r)
		unreachable = len(out) > 0
		return err
	}, "rev-list", "--max-count=1", "--stdin")
	return !unreachable, err
}
