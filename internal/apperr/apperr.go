// Package apperr carries the shared error codes from where a failure is
// understood to the RPC boundary, where it is sent to the frontend.
package apperr

import (
	"context"
	"errors"

	"github.com/jyecusch/forkit/internal/gitexec"
	"github.com/jyecusch/forkit/internal/model"
)

// Error is a failure the frontend can tell apart by its code.
type Error struct {
	Code    model.ErrorCode
	Message string
	Details map[string]string
}

func (e *Error) Error() string { return e.Message }

// New returns an error with a code and message.
func New(code model.ErrorCode, message string) *Error {
	return &Error{Code: code, Message: message}
}

// WithDetail adds a machine-readable detail, such as the ID of a worktree the
// frontend could offer to switch to.
func (e *Error) WithDetail(key, value string) *Error {
	if e.Details == nil {
		e.Details = map[string]string{}
	}
	e.Details[key] = value
	return e
}

// ToRPC converts any error into the shape sent to the frontend, recognising
// git failures that have their own codes.
func ToRPC(err error) model.RpcError {
	var appErr *Error
	var gitErr *gitexec.Error
	switch {
	case errors.As(err, &appErr):
		return model.RpcError{Code: appErr.Code, Message: appErr.Message, Details: appErr.Details}
	case errors.Is(err, context.Canceled):
		return model.RpcError{Code: model.ErrorCodeCancelled, Message: "cancelled"}
	case errors.Is(err, gitexec.ErrGitNotFound):
		return model.RpcError{Code: model.ErrorCodeGitNotFound, Message: err.Error()}
	case errors.Is(err, gitexec.ErrGitTooOld):
		return model.RpcError{Code: model.ErrorCodeGitTooOld, Message: err.Error()}
	case gitexec.IsNotARepo(err):
		return model.RpcError{Code: model.ErrorCodeNotARepo, Message: "not a git repository"}
	case gitexec.IsIndexLocked(err):
		return model.RpcError{Code: model.ErrorCodeIndexLocked, Message: "another git process is using this repository (index.lock exists)"}
	case errors.As(err, &gitErr):
		return model.RpcError{Code: model.ErrorCodeGitFailed, Message: gitErr.Stderr}
	}
	return model.RpcError{Code: model.ErrorCodeInternal, Message: err.Error()}
}
