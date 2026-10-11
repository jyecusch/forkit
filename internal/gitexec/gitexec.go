// Package gitexec runs the system git binary with cancellation, tracing and
// per-repository serialization of writes.
package gitexec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// MinVersion is the oldest git release Forkit supports. 2.36 added
// "worktree list -z".
var MinVersion = Version{Major: 2, Minor: 36}

// DefaultTimeout bounds Run calls whose context has no deadline.
const DefaultTimeout = 60 * time.Second

// commandEnv keeps git's output machine-readable and prevents it from
// blocking on input or taking optional locks during reads.
var commandEnv = []string{
	"LC_ALL=C",
	"GIT_TERMINAL_PROMPT=0",
	"GIT_OPTIONAL_LOCKS=0",
	"GIT_PAGER=cat",
}

// Git locates and runs a git binary.
type Git struct {
	binary  string
	version Version
	tracer  trace.Tracer

	writeLocksMu sync.Mutex
	writeLocks   map[string]*sync.Mutex
}

// New resolves binary (or "git" on PATH when empty) and checks that it is at
// least MinVersion.
func New(ctx context.Context, binary string, tracer trace.Tracer) (*Git, error) {
	if binary == "" {
		binary = "git"
	}
	path, err := exec.LookPath(binary)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrGitNotFound, binary)
	}
	g := &Git{binary: path, tracer: tracer, writeLocks: map[string]*sync.Mutex{}}
	out, err := g.run(ctx, "", []string{"version"}, nil)
	if err != nil {
		return nil, err
	}
	g.version, err = ParseVersion(string(out))
	if err != nil {
		return nil, err
	}
	if g.version.Less(MinVersion) {
		return nil, fmt.Errorf("%w: found %s, need %s or newer", ErrGitTooOld, g.version, MinVersion)
	}
	return g, nil
}

// Version returns the git version found by New.
func (g *Git) Version() Version { return g.version }

// Repo returns a handle that runs commands in dir. Writes are serialized per
// commonDir, so worktrees of one repository never contend for its locks.
func (g *Git) Repo(commonDir, dir string) *Repo {
	g.writeLocksMu.Lock()
	defer g.writeLocksMu.Unlock()
	lock, ok := g.writeLocks[commonDir]
	if !ok {
		lock = &sync.Mutex{}
		g.writeLocks[commonDir] = lock
	}
	return &Repo{git: g, dir: dir, writeLock: lock}
}

// Repo runs git commands in one directory of a repository.
type Repo struct {
	git       *Git
	dir       string
	writeLock *sync.Mutex
}

// Dir is the directory commands run in.
func (r *Repo) Dir() string { return r.dir }

// Run executes a read-only command and returns its stdout.
func (r *Repo) Run(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := withDefaultTimeout(ctx)
	defer cancel()
	return r.git.run(ctx, r.dir, args, nil)
}

// Mutate executes a command that changes the repository. Mutations of the
// same repository run one at a time so Forkit never races itself for
// index.lock or ref locks.
func (r *Repo) Mutate(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := withDefaultTimeout(ctx)
	defer cancel()
	r.writeLock.Lock()
	defer r.writeLock.Unlock()
	return r.git.run(ctx, r.dir, args, nil)
}

// Stream executes a read-only command and hands its stdout to consume as it
// is produced. The process is killed if consume returns early or ctx ends.
func (r *Repo) Stream(ctx context.Context, consume func(io.Reader) error, args ...string) error {
	_, err := r.git.run(ctx, r.dir, args, consume)
	return err
}

func withDefaultTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, DefaultTimeout)
}

func (g *Git) run(ctx context.Context, dir string, args []string, consume func(io.Reader) error) ([]byte, error) {
	ctx, span := g.tracer.Start(ctx, "git "+subcommand(args), trace.WithAttributes(
		attribute.String("git.subcommand", subcommand(args)),
		attribute.StringSlice("git.args", RedactArgs(args)),
	))
	defer span.End()

	cmd := exec.CommandContext(ctx, g.binary, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), commandEnv...)
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	var stdout bytes.Buffer
	counter := &countingReader{}
	if consume == nil {
		cmd.Stdout = &stdout
	} else {
		pipe, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		counter.r = pipe
	}

	if err := cmd.Start(); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}
	var consumeErr error
	if consume != nil {
		consumeErr = consume(counter)
		if consumeErr != nil {
			_ = cmd.Process.Kill()
		}
		_, _ = io.Copy(io.Discard, counter)
	}
	waitErr := cmd.Wait()

	bytesRead := int64(stdout.Len()) + counter.n
	span.SetAttributes(
		attribute.Int("process.exit_code", cmd.ProcessState.ExitCode()),
		attribute.Int64("git.stdout_bytes", bytesRead),
	)
	err := consumeErr
	if err == nil {
		err = g.commandError(ctx, args, waitErr, stderr.Bytes())
	}
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}
	return stdout.Bytes(), nil
}

func (g *Git) commandError(ctx context.Context, args []string, waitErr error, stderr []byte) error {
	if waitErr == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var exitErr *exec.ExitError
	if !errors.As(waitErr, &exitErr) {
		return waitErr
	}
	return &Error{Subcommand: subcommand(args), ExitCode: exitErr.ExitCode(), Stderr: string(bytes.TrimSpace(stderr))}
}

func subcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "-c" || args[i] == "-C":
			i++
		case len(args[i]) > 0 && args[i][0] == '-':
		default:
			return args[i]
		}
	}
	return ""
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// Version is a git release number.
type Version struct{ Major, Minor, Patch int }

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch) }

// Less reports whether v is older than other.
func (v Version) Less(other Version) bool {
	if v.Major != other.Major {
		return v.Major < other.Major
	}
	if v.Minor != other.Minor {
		return v.Minor < other.Minor
	}
	return v.Patch < other.Patch
}

var versionPattern = regexp.MustCompile(`git version (\d+)\.(\d+)(?:\.(\d+))?`)

// ParseVersion parses the output of "git version".
func ParseVersion(output string) (Version, error) {
	m := versionPattern.FindStringSubmatch(output)
	if m == nil {
		return Version{}, fmt.Errorf("unrecognised git version output %q", output)
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch, _ := strconv.Atoi(m[3])
	return Version{Major: major, Minor: minor, Patch: patch}, nil
}
