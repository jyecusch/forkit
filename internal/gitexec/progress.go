package gitexec

import (
	"bytes"
	"regexp"
	"strconv"
)

// Progress is how far a long command has got, from a line such as
// "Receiving objects:  45% (450/1000)".
type Progress struct {
	Phase          string
	Current, Total int
}

var progressLine = regexp.MustCompile(`^(?:remote: )?([A-Z][A-Za-z ]+):\s+\d+% \((\d+)/(\d+)\)`)

// parseProgress reads a progress line, which git ends with a carriage return
// while it counts and a newline once a phase is done.
func parseProgress(line []byte) (Progress, bool) {
	m := progressLine.FindSubmatch(line)
	if m == nil {
		return Progress{}, false
	}
	current, _ := strconv.Atoi(string(m[2]))
	total, _ := strconv.Atoi(string(m[3]))
	return Progress{Phase: string(m[1]), Current: current, Total: total}, true
}

// progressWriter collects a command's stderr. With onProgress set, it hands
// progress lines to it and keeps only the others, so an error shows what
// went wrong rather than how far the transfer got.
type progressWriter struct {
	onProgress func(Progress)
	kept       bytes.Buffer
	pending    []byte
}

func (w *progressWriter) Write(p []byte) (int, error) {
	if w.onProgress == nil {
		return w.kept.Write(p)
	}
	w.pending = append(w.pending, p...)
	for {
		end := bytes.IndexAny(w.pending, "\r\n")
		if end < 0 {
			return len(p), nil
		}
		w.line(w.pending[:end])
		w.pending = w.pending[end+1:]
	}
}

func (w *progressWriter) line(line []byte) {
	if progress, ok := parseProgress(line); ok {
		w.onProgress(progress)
		return
	}
	if len(bytes.TrimSpace(line)) > 0 {
		w.kept.Write(line)
		w.kept.WriteByte('\n')
	}
}

// output returns what was kept, including an unfinished last line.
func (w *progressWriter) output() []byte {
	if len(w.pending) > 0 {
		w.line(w.pending)
		w.pending = nil
	}
	return w.kept.Bytes()
}
