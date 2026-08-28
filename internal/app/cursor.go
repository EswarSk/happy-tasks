package app

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

type cursor struct {
	Time time.Time `json:"t"`
	ID   string    `json:"id"`
}

type memberCursor struct {
	DisplayName string `json:"n"`
	ID          string `json:"id"`
}

func EncodeTaskCursor(taskTime time.Time, id string) string {
	return encodeCursor(taskTime, id)
}

func DecodeTaskCursor(value string) (*TaskCursor, error) {
	c, err := decodeCursor(value)
	if err != nil {
		return nil, err
	}
	return &TaskCursor{UpdatedAt: c.Time, ID: c.ID}, nil
}

func EncodeCommentCursor(createdAt time.Time, id string) string {
	return encodeCursor(createdAt, id)
}

func DecodeCommentCursor(value string) (*CommentCursor, error) {
	c, err := decodeCursor(value)
	if err != nil {
		return nil, err
	}
	return &CommentCursor{CreatedAt: c.Time, ID: c.ID}, nil
}

func EncodeMemberCursor(displayName, id string) string {
	b, _ := json.Marshal(memberCursor{DisplayName: displayName, ID: id})
	return base64.RawURLEncoding.EncodeToString(b)
}

func DecodeMemberCursor(value string) (*MemberCursor, error) {
	var c memberCursor
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("decode member cursor: %w", err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parse member cursor: %w", err)
	}
	if c.DisplayName == "" || c.ID == "" {
		return nil, fmt.Errorf("member cursor is incomplete")
	}
	return &MemberCursor{DisplayName: c.DisplayName, ID: c.ID}, nil
}

func EncodeAssignmentCursor(occurredAt time.Time, id string) string {
	return encodeCursor(occurredAt, id)
}

func DecodeAssignmentCursor(value string) (*AssignmentCursor, error) {
	c, err := decodeCursor(value)
	if err != nil {
		return nil, err
	}
	return &AssignmentCursor{OccurredAt: c.Time, ID: c.ID}, nil
}

func EncodeNotificationCursor(createdAt time.Time, id string) string {
	return encodeCursor(createdAt, id)
}

func DecodeNotificationCursor(value string) (*NotificationCursor, error) {
	c, err := decodeCursor(value)
	if err != nil {
		return nil, err
	}
	return &NotificationCursor{CreatedAt: c.Time, ID: c.ID}, nil
}

func encodeCursor(t time.Time, id string) string {
	b, _ := json.Marshal(cursor{Time: t.UTC(), ID: id})
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(value string) (cursor, error) {
	var c cursor
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return c, fmt.Errorf("decode cursor: %w", err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("parse cursor: %w", err)
	}
	if c.Time.IsZero() || c.ID == "" {
		return c, fmt.Errorf("cursor is incomplete")
	}
	return c, nil
}
