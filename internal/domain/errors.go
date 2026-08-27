package domain

import "fmt"

// Error is stable across transports. Code is safe for clients; Cause is for logs.
type Error struct {
	Code    string
	Message string
	Details map[string]any
	Cause   error
}

func (e *Error) Error() string {
	if e.Cause == nil {
		return e.Message
	}
	return fmt.Sprintf("%s: %v", e.Message, e.Cause)
}

func (e *Error) Unwrap() error { return e.Cause }

func NewError(code, message string) *Error {
	return &Error{Code: code, Message: message}
}

var (
	ErrNotFound  = NewError("NOT_FOUND", "The requested resource was not found.")
	ErrForbidden = NewError("FORBIDDEN", "The actor is not a member of this project.")
)

func Validation(code, message string, details map[string]any) *Error {
	return &Error{Code: code, Message: message, Details: details}
}
