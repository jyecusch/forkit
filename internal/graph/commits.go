package graph

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// commitReader reads commit metadata through one long-running
// "git cat-file --batch" process, which is far cheaper than a process per
// window.
type commitReader struct {
	repo *gitexec.Repo
	ctx  context.Context

	mu   sync.Mutex
	proc *gitexec.Process
}

func newCommitReader(ctx context.Context, repo *gitexec.Repo) *commitReader {
	return &commitReader{repo: repo, ctx: ctx}
}

// Read returns the commits in the order given.
func (c *commitReader) Read(oids []model.OID) ([]model.Commit, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.proc == nil {
		proc, err := c.repo.Start(c.ctx, "cat-file", "--batch")
		if err != nil {
			return nil, err
		}
		c.proc = proc
	}
	commits, err := c.readBatch(oids)
	if err != nil {
		c.proc.Close()
		c.proc = nil
	}
	return commits, err
}

func (c *commitReader) readBatch(oids []model.OID) ([]model.Commit, error) {
	writeErr := make(chan error, 1)
	go func() {
		w := bufio.NewWriter(c.proc.Stdin)
		for _, oid := range oids {
			_, _ = w.WriteString(string(oid))
			_ = w.WriteByte('\n')
		}
		writeErr <- w.Flush()
	}()

	commits := make([]model.Commit, 0, len(oids))
	for range oids {
		commit, err := readCommitObject(c.proc.Stdout)
		if err != nil {
			return nil, err
		}
		commits = append(commits, commit)
	}
	return commits, <-writeErr
}

// Close stops the cat-file process.
func (c *commitReader) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.proc != nil {
		c.proc.Close()
		c.proc = nil
	}
}

func readCommitObject(r *bufio.Reader) (model.Commit, error) {
	header, err := r.ReadString('\n')
	if err != nil {
		return model.Commit{}, err
	}
	fields := strings.Fields(header)
	if len(fields) != 3 || fields[1] != "commit" {
		return model.Commit{}, fmt.Errorf("unexpected cat-file header %q", header)
	}
	size, err := strconv.Atoi(fields[2])
	if err != nil {
		return model.Commit{}, err
	}
	body := make([]byte, size+1) // object plus trailing newline
	if _, err := io.ReadFull(r, body); err != nil {
		return model.Commit{}, err
	}
	return parseCommitObject(model.OID(fields[0]), body[:size]), nil
}

func parseCommitObject(oid model.OID, object []byte) model.Commit {
	commit := model.Commit{OID: oid}
	headers, message, _ := bytes.Cut(object, []byte("\n\n"))
	for _, line := range bytes.Split(headers, []byte("\n")) {
		key, value, _ := bytes.Cut(line, []byte(" "))
		switch string(key) {
		case "parent":
			commit.Parents = append(commit.Parents, model.OID(value))
		case "author":
			commit.AuthorName, commit.AuthorEmail, commit.AuthorTime = parseSignature(value)
		case "committer":
			_, _, commit.CommitterTime = parseSignature(value)
		}
	}
	subject, _, _ := bytes.Cut(message, []byte("\n"))
	commit.Subject = string(subject)
	return commit
}

// parseSignature parses "Name <email> 1700000000 +1100".
func parseSignature(value []byte) (name, email string, at model.UnixMillis) {
	open := bytes.LastIndexByte(value, '<')
	closing := bytes.LastIndexByte(value, '>')
	if open < 0 || closing < open {
		return string(value), "", 0
	}
	name = string(bytes.TrimSpace(value[:open]))
	email = string(value[open+1 : closing])
	seconds, _, _ := bytes.Cut(bytes.TrimSpace(value[closing+1:]), []byte(" "))
	unix, _ := strconv.ParseInt(string(seconds), 10, 64)
	return name, email, model.UnixMillis(unix * 1000)
}
