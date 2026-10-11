package graph

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
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
}

// streamLog lists the commits reachable from include but not from exclude in
// display order, handing them to onBatch in groups as git produces them.
func streamLog(ctx context.Context, repo *gitexec.Repo, order model.GraphOrder, include, exclude []model.OID, onBatch func([]logEntry) error) error {
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
		return parseLog(r, onBatch)
	}, "log", orderFlag, "--format=%H %P", "--stdin")
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
	}
	return nil
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
