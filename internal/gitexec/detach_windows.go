package gitexec

import "os/exec"

// detach does nothing on Windows, where a GUI app's children have no console
// to prompt on.
func detach(*exec.Cmd) {}
