package watch

import (
	"time"

	"github.com/fsnotify/fsevents"
)

// fseventsSource watches whole directory trees with one FSEvents stream,
// which costs the same however many files they contain.
type fseventsSource struct {
	stream *fsevents.EventStream
	events chan []string
	done   chan struct{}
}

func newSource(roots []string) (source, error) {
	stream := &fsevents.EventStream{
		Paths:   roots,
		Latency: 10 * time.Millisecond,
		Flags:   fsevents.FileEvents | fsevents.NoDefer,
	}
	if err := stream.Start(); err != nil {
		return nil, err
	}
	s := &fseventsSource{stream: stream, events: make(chan []string), done: make(chan struct{})}
	go s.forward()
	return s, nil
}

func (s *fseventsSource) forward() {
	defer close(s.events)
	for {
		select {
		case <-s.done:
			return
		case batch, ok := <-s.stream.Events:
			if !ok {
				return
			}
			paths := make([]string, len(batch))
			for i, event := range batch {
				paths[i] = "/" + trimLeadingSlash(event.Path)
			}
			select {
			case s.events <- paths:
			case <-s.done:
				return
			}
		}
	}
}

func trimLeadingSlash(path string) string {
	for len(path) > 0 && path[0] == '/' {
		path = path[1:]
	}
	return path
}

func (s *fseventsSource) Events() <-chan []string { return s.events }

func (s *fseventsSource) Unwatched() []string { return nil }

func (s *fseventsSource) Close() error {
	close(s.done)
	s.stream.Stop()
	return nil
}
