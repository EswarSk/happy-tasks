package domain

import "strings"

func ValidStatus(status Status) bool {
	switch status {
	case StatusTodo, StatusInProgress, StatusBlocked, StatusDone:
		return true
	default:
		return false
	}
}

func ValidPriority(priority Priority) bool {
	switch priority {
	case PriorityLow, PriorityMedium, PriorityHigh, PriorityUrgent:
		return true
	default:
		return false
	}
}

func ValidMembershipStatus(status MembershipStatus) bool {
	switch status {
	case MembershipActive, MembershipInvited, MembershipSuspended, MembershipRemoved:
		return true
	default:
		return false
	}
}

func ValidProjectRole(role ProjectRole) bool {
	switch role {
	case RoleOwner, RoleAdmin, RoleMember, RoleViewer:
		return true
	default:
		return false
	}
}

func CanMutateProject(role ProjectRole) bool {
	return role == RoleOwner || role == RoleAdmin || role == RoleMember
}

func CanManageMembers(role ProjectRole) bool {
	return role == RoleOwner || role == RoleAdmin
}

func CanManageMembership(actorRole, targetRole, nextRole ProjectRole) bool {
	if actorRole == RoleOwner {
		return true
	}
	if actorRole != RoleAdmin {
		return false
	}
	return targetRole != RoleOwner && nextRole != RoleOwner
}

func CanTransitionMembership(from, to MembershipStatus) bool {
	if from == to {
		return true
	}
	switch from {
	case MembershipInvited:
		return to == MembershipActive || to == MembershipRemoved
	case MembershipActive:
		return to == MembershipSuspended || to == MembershipRemoved
	case MembershipSuspended:
		return to == MembershipActive || to == MembershipRemoved
	case MembershipRemoved:
		return to == MembershipInvited
	default:
		return false
	}
}

func ValidateMembership(role ProjectRole, status MembershipStatus) error {
	if !ValidProjectRole(role) {
		return Validation("VALIDATION_ERROR", "Unknown project role.", map[string]any{"field": "role"})
	}
	if !ValidMembershipStatus(status) {
		return Validation("VALIDATION_ERROR", "Unknown membership status.", map[string]any{"field": "status"})
	}
	return nil
}

func CanTransition(from, to Status) bool {
	if from == to {
		return true
	}
	switch from {
	case StatusTodo:
		return to == StatusInProgress || to == StatusBlocked
	case StatusInProgress:
		return to == StatusTodo || to == StatusBlocked || to == StatusDone
	case StatusBlocked:
		return to == StatusTodo || to == StatusInProgress
	case StatusDone:
		return to == StatusInProgress
	default:
		return false
	}
}

func ValidateProject(name, description string) error {
	if n := len(strings.TrimSpace(name)); n < 1 || n > 200 {
		return Validation("VALIDATION_ERROR", "Project name must be between 1 and 200 characters.", map[string]any{"field": "name"})
	}
	if len(description) > 10_000 {
		return Validation("VALIDATION_ERROR", "Project description must not exceed 10000 characters.", map[string]any{"field": "description"})
	}
	return nil
}

func ValidateTask(title, description string, status Status, priority Priority, tags []string) error {
	if n := len(strings.TrimSpace(title)); n < 1 || n > 300 {
		return Validation("VALIDATION_ERROR", "Task title must be between 1 and 300 characters.", map[string]any{"field": "title"})
	}
	if len(description) > 50_000 {
		return Validation("VALIDATION_ERROR", "Task description must not exceed 50000 characters.", map[string]any{"field": "description"})
	}
	if !ValidStatus(status) {
		return Validation("VALIDATION_ERROR", "Unknown task status.", map[string]any{"field": "status"})
	}
	if !ValidPriority(priority) {
		return Validation("VALIDATION_ERROR", "Unknown task priority.", map[string]any{"field": "priority"})
	}
	if len(tags) > 25 {
		return Validation("VALIDATION_ERROR", "A task may have at most 25 tags.", map[string]any{"field": "tags"})
	}
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if len(tag) < 1 || len(tag) > 64 {
			return Validation("VALIDATION_ERROR", "Tags must be between 1 and 64 characters.", map[string]any{"field": "tags"})
		}
		if _, exists := seen[tag]; exists {
			return Validation("DUPLICATE_TAG", "A task may not contain duplicate tags.", map[string]any{"tag": tag})
		}
		seen[tag] = struct{}{}
	}
	return nil
}

func ValidateTransition(from, to Status) error {
	if !CanTransition(from, to) {
		return Validation("INVALID_STATUS_TRANSITION", "The requested status transition is not allowed.", map[string]any{"from": from, "to": to})
	}
	return nil
}

func ValidateComment(body string) error {
	if n := len(strings.TrimSpace(body)); n < 1 || n > 10_000 {
		return Validation("VALIDATION_ERROR", "Comment body must be between 1 and 10000 characters.", map[string]any{"field": "body"})
	}
	return nil
}
