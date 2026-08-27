package domain

import "testing"

func TestStatusTransitions(t *testing.T) {
	tests := []struct {
		from, to Status
		allowed  bool
	}{
		{StatusTodo, StatusInProgress, true},
		{StatusTodo, StatusDone, false},
		{StatusInProgress, StatusDone, true},
		{StatusDone, StatusTodo, false},
		{StatusDone, StatusInProgress, true},
		{StatusBlocked, StatusDone, false},
		{StatusBlocked, StatusTodo, true},
		{StatusTodo, StatusTodo, true},
	}
	for _, test := range tests {
		if got := CanTransition(test.from, test.to); got != test.allowed {
			t.Errorf("CanTransition(%s, %s) = %v, want %v", test.from, test.to, got, test.allowed)
		}
	}
}

func TestValidateTaskRejectsDuplicateTags(t *testing.T) {
	err := ValidateTask("title", "", StatusTodo, PriorityMedium, []string{"api", "api"})
	if err == nil {
		t.Fatal("expected duplicate tags to be rejected")
	}
}
