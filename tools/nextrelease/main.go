// Command nextrelease works out the next version from the Conventional
// Commits since the last release, and writes release notes for it.
//
// It prints the version, without a leading v, or nothing when no commit
// since the last release calls for one:
//
//	go run ./tools/nextrelease -since v0.1.0 -notes notes.md
//
// Breaking changes bump the major version, features the minor and fixes and
// performance work the patch. Before 1.0.0, breaking changes bump the minor
// version instead, as is usual for pre-1.0 software.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

func main() {
	since := flag.String("since", "", "tag of the last release, such as v0.1.0; empty for the first release")
	notesPath := flag.String("notes", "", "file to write release notes to")
	flag.Parse()

	base, err := parseVersion(*since)
	if err != nil {
		log.Fatal(err)
	}
	commits, err := commitsSince(*since)
	if err != nil {
		log.Fatal(err)
	}
	next, ok := nextVersion(base, *since == "", commits)
	if !ok {
		return
	}
	if *notesPath != "" {
		if err := os.WriteFile(*notesPath, []byte(releaseNotes(commits)), 0o644); err != nil {
			log.Fatal(err)
		}
	}
	fmt.Println(next)
}

// Version is a semantic version without pre-release or build parts.
type Version struct{ Major, Minor, Patch int }

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch) }

var versionTag = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)$`)

func parseVersion(tag string) (Version, error) {
	if tag == "" {
		return Version{}, nil
	}
	m := versionTag.FindStringSubmatch(tag)
	if m == nil {
		return Version{}, fmt.Errorf("%q is not a version tag like v1.2.3", tag)
	}
	parts := make([]int, 3)
	for i := range parts {
		parts[i], _ = strconv.Atoi(m[i+1])
	}
	return Version{parts[0], parts[1], parts[2]}, nil
}

// Commit is a Conventional Commit; Type is empty for any other message.
type Commit struct {
	Hash, Type, Scope, Description string
	Breaking                       bool
}

var header = regexp.MustCompile(`^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$`)

func parseCommit(hash, subject, body string) Commit {
	c := Commit{Hash: hash, Description: subject}
	if m := header.FindStringSubmatch(subject); m != nil {
		c.Type, c.Scope, c.Breaking, c.Description = strings.ToLower(m[1]), m[2], m[3] == "!", m[4]
	}
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "BREAKING CHANGE:") || strings.HasPrefix(line, "BREAKING-CHANGE:") {
			c.Breaking = true
		}
	}
	return c
}

// commitsSince lists the commits after tag up to HEAD, newest first.
func commitsSince(tag string) ([]Commit, error) {
	revisions := "HEAD"
	if tag != "" {
		revisions = tag + "..HEAD"
	}
	out, err := exec.Command("git", "log", "--format=%H%x1f%s%x1f%b%x1e", revisions).Output()
	if err != nil {
		return nil, fmt.Errorf("git log %s: %w", revisions, err)
	}
	var commits []Commit
	for _, record := range strings.Split(string(out), "\x1e") {
		fields := strings.SplitN(strings.TrimSpace(record), "\x1f", 3)
		if len(fields) < 2 {
			continue
		}
		body := ""
		if len(fields) == 3 {
			body = fields[2]
		}
		commits = append(commits, parseCommit(fields[0], fields[1], body))
	}
	return commits, nil
}

// nextVersion bumps base for the most significant change in commits. The
// first release starts at 0.1.0. It returns false when nothing calls for a
// release.
func nextVersion(base Version, first bool, commits []Commit) (Version, bool) {
	var breaking, feature, fix bool
	for _, c := range commits {
		breaking = breaking || c.Breaking
		feature = feature || c.Type == "feat"
		fix = fix || c.Type == "fix" || c.Type == "perf"
	}
	switch {
	case first && (breaking || feature || fix):
		return Version{0, 1, 0}, true
	case breaking && base.Major > 0:
		return Version{base.Major + 1, 0, 0}, true
	case breaking || feature:
		return Version{base.Major, base.Minor + 1, 0}, true
	case fix:
		return Version{base.Major, base.Minor, base.Patch + 1}, true
	}
	return base, false
}

// releaseNotes lists the changes worth announcing, oldest first within each
// section.
func releaseNotes(commits []Commit) string {
	sections := []struct {
		title   string
		matches func(Commit) bool
	}{
		{"Breaking changes", func(c Commit) bool { return c.Breaking }},
		{"Features", func(c Commit) bool { return c.Type == "feat" && !c.Breaking }},
		{"Bug fixes", func(c Commit) bool { return c.Type == "fix" && !c.Breaking }},
		{"Performance", func(c Commit) bool { return c.Type == "perf" && !c.Breaking }},
	}
	var notes strings.Builder
	for _, section := range sections {
		var lines []string
		for i := len(commits) - 1; i >= 0; i-- {
			if c := commits[i]; section.matches(c) {
				lines = append(lines, "- "+entry(c))
			}
		}
		if len(lines) > 0 {
			fmt.Fprintf(&notes, "## %s\n\n%s\n\n", section.title, strings.Join(lines, "\n"))
		}
	}
	return strings.TrimSpace(notes.String()) + "\n"
}

func entry(c Commit) string {
	text := c.Description
	if c.Scope != "" {
		text = "**" + c.Scope + ":** " + text
	}
	return fmt.Sprintf("%s (%s)", text, c.Hash[:min(7, len(c.Hash))])
}
