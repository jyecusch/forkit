//go:build !windows

package gitexec

import (
	"os/exec"
	"syscall"
)

// detach starts cmd in a session of its own, without a controlling terminal,
// so ssh and git cannot open /dev/tty to prompt.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
