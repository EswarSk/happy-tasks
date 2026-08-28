package app

import (
	"testing"

	"github.com/eswaravegi/happy-task-management/internal/domain"
)

func TestTaskOperationFieldsAllowIndependentEdits(t *testing.T) {
	status := domain.StatusInProgress
	priority := domain.PriorityHigh
	statusFields := changedTaskFields(UpdateTaskInput{Status: &status})
	priorityFields := changedTaskFields(UpdateTaskInput{Priority: &priority})
	if fieldsOverlap(statusFields, priorityFields) {
		t.Fatal("status and priority must be independent operation fields")
	}
	if !fieldsOverlap(statusFields, []string{"status", "description"}) {
		t.Fatal("same-field operation should conflict")
	}
}

func TestTaskOperationStateRoundTrip(t *testing.T) {
	task := domain.Task{
		Title: "Ship it", Description: "Context", Status: domain.StatusTodo,
		Priority: domain.PriorityMedium, CustomFields: map[string]any{"effort": "M"},
		AssigneeIDs: []string{"b", "a"}, Tags: []string{"beta", "alpha"},
	}
	fields := []string{"title", "description", "status", "priority", "customFields", "assigneeIds", "tags"}
	state := taskState(task, fields)
	input, err := taskInputFromState(state, fields)
	if err != nil {
		t.Fatalf("round trip state: %v", err)
	}
	var rebuilt domain.Task
	applyTaskInput(&rebuilt, input)
	if rebuilt.Title != task.Title || rebuilt.Description != task.Description || rebuilt.Status != task.Status || rebuilt.Priority != task.Priority {
		t.Fatalf("scalar operation state did not round trip: %#v", rebuilt)
	}
	if len(rebuilt.AssigneeIDs) != 2 || rebuilt.AssigneeIDs[0] != "a" || rebuilt.Tags[0] != "alpha" {
		t.Fatalf("list operation state was not normalized: %#v", rebuilt)
	}
}
