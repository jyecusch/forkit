package gitexec

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	ErrGitNotFound = errors.New("git not found")
	ErrGitTooOld   = errors.New("git is too old")
)

// Error is a git process that exited with a non-zero status.
type Error struct {
	Subcommand string
	ExitCode   int
	Stderr     string
}

func (e *Error) Error() string {
	return fmt.Sprintf("git %s exited with %d: %s", e.Subcommand, e.ExitCode, e.Stderr)
}

// IsIndexLocked reports whether git failed because another process holds the
// repository's index.lock.
func IsIndexLocked(err error) bool {
	return stderrContains(err, "index.lock': File exists")
}

// IsNotARepo reports whether git failed because it was not run inside a
// repository.
func IsNotARepo(err error) bool {
	return stderrContains(err, "not a git repository")
}

func stderrContains(err error, text string) bool {
	var gitErr *Error
	return errors.As(err, &gitErr) && strings.Contains(gitErr.Stderr, text)
}

var scpLikeURL = regexp.MustCompile(`^[\w.-]+@[\w.-]+:`)

// RedactArgs replaces URLs, absolute paths and pathspecs in git arguments so
// they can be recorded in telemetry.
func RedactArgs(args []string) []string {
	redacted := make([]string, len(args))
	afterDoubleDash := false
	for i, arg := range args {
		switch {
		case afterDoubleDash:
			redacted[i] = "<path>"
		case arg == "--":
			redacted[i] = arg
			afterDoubleDash = true
		default:
			redacted[i] = redactArg(arg)
		}
	}
	return redacted
}

func redactArg(arg string) string {
	if name, value, ok := strings.Cut(arg, "="); ok && strings.HasPrefix(name, "-") {
		return name + "=" + redactArg(value)
	}
	switch {
	case strings.Contains(arg, "://") || scpLikeURL.MatchString(arg):
		return "<url>"
	case filepath.IsAbs(arg) || strings.HasPrefix(arg, "~"):
		return "<path>"
	}
	return arg
}

// ExitCode returns the exit status of a failed git process, or -1 when err is
// nil or did not come from git exiting.
func ExitCode(err error) int {
	var gitErr *Error
	if errors.As(err, &gitErr) {
		return gitErr.ExitCode
	}
	return -1
}
