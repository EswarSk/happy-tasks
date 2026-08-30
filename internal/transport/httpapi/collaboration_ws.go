package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/messaging"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	presenceWriteWait  = 10 * time.Second
	presencePingPeriod = 30 * time.Second
	maxPresenceFrame   = 16 << 10
)

type presenceFrame struct {
	Type          string `json:"type"`
	SessionID     string `json:"sessionId,omitempty"`
	ActorID       string `json:"actorId,omitempty"`
	TaskID        string `json:"taskId,omitempty"`
	SelectionFrom int    `json:"selectionFrom,omitempty"`
	SelectionTo   int    `json:"selectionTo,omitempty"`
}

type presenceClient struct {
	conn      *websocket.Conn
	send      chan []byte
	done      chan struct{}
	once      sync.Once
	actorID   string
	sessionID string
}

type presenceHub struct {
	mu    sync.RWMutex
	rooms map[string]map[*presenceClient]struct{}
}

func newPresenceHub() *presenceHub {
	return &presenceHub{rooms: make(map[string]map[*presenceClient]struct{})}
}

func (h *presenceHub) join(room string, client *presenceClient) {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = make(map[*presenceClient]struct{})
	}
	h.rooms[room][client] = struct{}{}
	h.mu.Unlock()
}

func (h *presenceHub) leave(room string, client *presenceClient) {
	h.mu.Lock()
	delete(h.rooms[room], client)
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
	}
	h.mu.Unlock()
	client.close()
}

func (h *presenceHub) snapshot(room string) []presenceFrame {
	h.mu.RLock()
	defer h.mu.RUnlock()
	frames := make([]presenceFrame, 0, len(h.rooms[room]))
	for client := range h.rooms[room] {
		frames = append(frames, presenceFrame{Type: "presence", SessionID: client.sessionID, ActorID: client.actorID})
	}
	return frames
}

func (h *presenceHub) broadcast(room string, sender *presenceClient, frame presenceFrame) {
	excluded := ""
	if sender != nil {
		excluded = sender.sessionID
	}
	h.broadcastSession(room, excluded, frame)
}

func (h *presenceHub) broadcastSession(room, excludedSessionID string, frame presenceFrame) {
	payload, err := json.Marshal(frame)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := make([]*presenceClient, 0, len(h.rooms[room]))
	for client := range h.rooms[room] {
		if client.sessionID != excludedSessionID {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()
	for _, client := range clients {
		select {
		case client.send <- payload:
		case <-client.done:
		default:
			client.close()
		}
	}
}

func (c *presenceClient) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *presenceClient) sendJSON(frame presenceFrame) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	select {
	case c.send <- payload:
		return nil
	case <-c.done:
		return http.ErrHandlerTimeout
	}
}

func (h *Handler) collaborationWebSocket(w http.ResponseWriter, r *http.Request) {
	projectID, ok := pathUUID(w, r, "projectId")
	if !ok {
		return
	}
	actorID := h.actorID(r)
	if _, err := h.service.GetProject(r.Context(), actorID, projectID); err != nil {
		h.writeError(w, r, err)
		return
	}
	upgrader := websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 1024, CheckOrigin: h.websocketOriginAllowed}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &presenceClient{conn: conn, send: make(chan []byte, 32), done: make(chan struct{}), actorID: actorID, sessionID: uuid.Must(uuid.NewV7()).String()}
	room := projectID
	h.presenceHub.join(room, client)
	defer func() {
		h.presenceHub.leave(room, client)
		leave := presenceFrame{Type: "leave", SessionID: client.sessionID, ActorID: actorID}
		if h.realtime != nil {
			if err := h.realtime.RemovePresence(context.Background(), projectID, toMessagingPresence(leave)); err == nil {
				return
			}
		}
		h.presenceHub.broadcast(room, client, leave)
	}()
	go presenceWriter(client)
	snapshot := h.presenceHub.snapshot(room)
	if h.realtime != nil {
		if remote, err := h.realtime.ListPresence(r.Context(), projectID); err == nil {
			snapshot = snapshot[:0]
			for _, item := range remote {
				snapshot = append(snapshot, fromMessagingPresence(item))
			}
		}
	}
	for _, frame := range snapshot {
		if frame.SessionID != client.sessionID {
			_ = client.sendJSON(frame)
		}
	}
	_ = client.sendJSON(presenceFrame{Type: "welcome", SessionID: client.sessionID, ActorID: actorID})
	initial := presenceFrame{Type: "presence", SessionID: client.sessionID, ActorID: actorID}
	if h.realtime != nil {
		if err := h.realtime.PutPresence(r.Context(), projectID, toMessagingPresence(initial)); err != nil {
			h.presenceHub.broadcast(room, client, initial)
		}
	} else {
		h.presenceHub.broadcast(room, client, initial)
	}

	conn.SetReadLimit(maxPresenceFrame)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	for {
		_, raw, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		var frame presenceFrame
		if json.Unmarshal(raw, &frame) != nil || frame.Type != "presence" {
			continue
		}
		if frame.TaskID != "" && !validUUID(frame.TaskID) {
			continue
		}
		if frame.SelectionFrom < 0 || frame.SelectionTo < frame.SelectionFrom || frame.SelectionTo > 100_000 {
			continue
		}
		frame.SessionID = client.sessionID
		frame.ActorID = client.actorID
		if h.realtime != nil {
			if err := h.realtime.PutPresence(r.Context(), projectID, toMessagingPresence(frame)); err == nil {
				continue
			}
		}
		h.presenceHub.broadcast(room, client, frame)
	}
}

func toMessagingPresence(frame presenceFrame) messaging.Presence {
	return messaging.Presence{Type: frame.Type, SessionID: frame.SessionID, ActorID: frame.ActorID, TaskID: frame.TaskID, SelectionFrom: frame.SelectionFrom, SelectionTo: frame.SelectionTo}
}

func fromMessagingPresence(item messaging.Presence) presenceFrame {
	return presenceFrame{Type: item.Type, SessionID: item.SessionID, ActorID: item.ActorID, TaskID: item.TaskID, SelectionFrom: item.SelectionFrom, SelectionTo: item.SelectionTo}
}

func presenceWriter(client *presenceClient) {
	ticker := time.NewTicker(presencePingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-client.done:
			return
		case <-ticker.C:
			_ = client.conn.SetWriteDeadline(time.Now().Add(presenceWriteWait))
			if err := client.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(presenceWriteWait)); err != nil {
				client.close()
				return
			}
		case payload := <-client.send:
			_ = client.conn.SetWriteDeadline(time.Now().Add(presenceWriteWait))
			if err := client.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				client.close()
				return
			}
		}
	}
}
