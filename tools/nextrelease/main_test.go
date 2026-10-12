package main

import (
	"strings"
	"testing"
)

func TestParseCommit(t *testing.T) {
	cases := []struct {
		subject, body string
		want          Commit
	}{
		{"feat(ui): add tabs", "", Commit{Type: "feat", Scope: "ui", Description: "add tabs"}},
		{"fix: crash", "", Commit{Type: "fix", Description: "crash"}},
		{"feat!: drop v1 config", "", Commit{Type: "feat", Description: "drop v1 config", Breaking: true}},
		{"refactor: tidy", "Details.\n\nBREAKING CHANGE: the API moved", Commit{Type: "refactor", Description: "tidy", Breaking: true}},
		{"Merge pull request #3", "", Commit{Description: "Merge pull request #3"}},
	}
	for _, c := range cases {
		got := parseCommit("", c.subject, c.body)
		if got != c.want {
			t.Errorf("parseCommit(%q) = %+v, want %+v", c.subject, got, c.want)
		}
	}
}

func TestNextVersion(t *testing.T) {
	feat := Commit{Type: "feat"}
	fix := Commit{Type: "fix"}
	breaking := Commit{Type: "fix", Breaking: true}
	chore := Commit{Type: "chore"}
	cases := []struct {
		name    string
		base    string
		commits []Commit
		want    string
	}{
		{"first release", "", []Commit{chore, fix}, "0.1.0"},
		{"feature bumps minor", "v0.1.0", []Commit{fix, feat}, "0.2.0"},
		{"fix bumps patch", "v0.1.0", []Commit{fix, chore}, "0.1.1"},
		{"breaking before 1.0 bumps minor", "v0.4.2", []Commit{breaking}, "0.5.0"},
		{"breaking after 1.0 bumps major", "v1.4.2", []Commit{breaking, feat}, "2.0.0"},
		{"nothing to release", "v0.1.0", []Commit{chore}, ""},
	}
	for _, c := range cases {
		base, err := parseVersion(c.base)
		if err != nil {
			t.Fatal(err)
		}
		got, ok := nextVersion(base, c.base == "", c.commits)
		if gotString := map[bool]string{true: got.String()}[ok]; gotString != c.want {
			t.Errorf("%s: got %q, want %q", c.name, gotString, c.want)
		}
	}
}

func TestReleaseNotes(t *testing.T) {
	// Newest first, as git log lists them.
	notes := releaseNotes([]Commit{
		{Hash: "3333333abc", Type: "fix", Scope: "graph", Description: "keep lanes aligned"},
		{Hash: "2222222abc", Type: "chore", Description: "bump deps"},
		{Hash: "1111111abc", Type: "feat", Description: "open repositories"},
		{Hash: "0000000abc", Type: "feat", Description: "show history"},
	})
	want := strings.Join([]string{
		"## Features",
		"",
		"- show history (0000000)",
		"- open repositories (1111111)",
		"",
		"## Bug fixes",
		"",
		"- **graph:** keep lanes aligned (3333333)",
		"",
	}, "\n")
	if notes != want {
		t.Errorf("notes:\n%s\nwant:\n%s", notes, want)
	}
}
