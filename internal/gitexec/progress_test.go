package gitexec

import (
	"slices"
	"testing"
)

func TestProgressWriterSeparatesProgressFromMessages(t *testing.T) {
	var seen []Progress
	w := &progressWriter{onProgress: func(p Progress) { seen = append(seen, p) }}
	// Git rewrites a progress line with carriage returns, in pieces.
	for _, chunk := range []string{
		"remote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\n",
		"Receiving obj", "ects:  10% (10/100)\r",
		"Receiving objects: 100% (100/100), 1.2 MiB | 2.0 MiB/s, done.\n",
		"To example.com:repo.git\n ! [rejected]        main -> main (fetch first)\n",
		"error: failed to push some refs",
	} {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}

	want := []Progress{
		{Phase: "Counting objects", Current: 1, Total: 2},
		{Phase: "Counting objects", Current: 2, Total: 2},
		{Phase: "Receiving objects", Current: 10, Total: 100},
		{Phase: "Receiving objects", Current: 100, Total: 100},
	}
	if !slices.Equal(seen, want) {
		t.Errorf("progress = %+v, want %+v", seen, want)
	}
	wantOutput := "To example.com:repo.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n"
	if got := string(w.output()); got != wantOutput {
		t.Errorf("output = %q, want %q", got, wantOutput)
	}
}

func TestProgressWriterKeepsEverythingWithoutAListener(t *testing.T) {
	w := &progressWriter{}
	_, _ = w.Write([]byte("Receiving objects: 100% (1/1)\rfatal: oops\n"))
	if got := string(w.output()); got != "Receiving objects: 100% (1/1)\rfatal: oops\n" {
		t.Errorf("output = %q", got)
	}
}
