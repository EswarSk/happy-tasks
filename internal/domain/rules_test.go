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

func TestMembershipTransitions(t *testing.T) {
	tests := []struct {
		from, to MembershipStatus
		allowed  bool
	}{
		{MembershipInvited, MembershipActive, true},
		{MembershipInvited, MembershipSuspended, false},
		{MembershipActive, MembershipSuspended, true},
		{MembershipActive, MembershipInvited, false},
		{MembershipSuspended, MembershipActive, true},
		{MembershipRemoved, MembershipInvited, true},
		{MembershipRemoved, MembershipActive, false},
	}
	for _, test := range tests {
		if got := CanTransitionMembership(test.from, test.to); got != test.allowed {
			t.Errorf("CanTransitionMembership(%s, %s) = %v, want %v", test.from, test.to, got, test.allowed)
		}
	}
}

func TestRolePolicy(t *testing.T) {
	if CanMutateProject(RoleViewer) {
		t.Fatal("viewer must not mutate project resources")
	}
	if !CanMutateProject(RoleMember) {
		t.Fatal("member should mutate project resources")
	}
	if CanManageMembership(RoleAdmin, RoleOwner, RoleMember) {
		t.Fatal("admin must not manage an owner")
	}
	if CanManageMembership(RoleAdmin, RoleMember, RoleOwner) {
		t.Fatal("admin must not promote to owner")
	}
	if !CanManageMembership(RoleOwner, RoleOwner, RoleMember) {
		t.Fatal("owner should manage roles subject to final-owner policy")
	}
}
