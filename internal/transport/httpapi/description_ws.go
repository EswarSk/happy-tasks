package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/eswaravegi/happy-task-management/internal/app"
	"github.com/eswaravegi/happy-task-management/internal/domain"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	maxDescriptionEditors = 100
	descriptionMaxFrame   = 2 << 20
	descriptionWriteWait  = 10 * time.Second
	descriptionPingPeriod = 30 * time.Second
)

type descriptionFrame struct {
	Type        string   `json:"type"`
	MessageID   string   `json:"messageId,omitempty"`
	Update      string   `json:"update,omitempty"`
	Text        string   `json:"text,omitempty"`
	ActorID     string   `json:"actorId,omitempty"`
	Initialized bool     `json:"initialized,omitempty"`
	ReadOnly    bool     `json:"readOnly,omitempty"`
	Snapshot    string   `json:"snapshot,omitempty"`
	Updates     []string `json:"updates,omitempty"`
	Version     int64    `json:"version,omitempty"`
	Error       string   `json:"error,omitempty"`
}

type descriptionClient struct {
	conn   *websocket.Conn
	send   chan []byte
	done   chan struct{}
	once   sync.Once
	editor bool
}

type descriptionHub struct {
	mu    sync.RWMutex
	rooms map[string]map[*descriptionClient]struct{}
}

func newDescriptionHub() *descriptionHub {
	return &descriptionHub{rooms: make(map[string]map[*descriptionClient]struct{})}
}

func (h *descriptionHub) join(room string, client *descriptionClient) bool {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = make(map[*descriptionClient]struct{})
	}
	editors := 0
	for member := range h.rooms[room] {
		if member.editor {
			editors++
		}
	}
	client.editor = editors < maxDescriptionEditors
	h.rooms[room][client] = struct{}{}
	h.mu.Unlock()
	return client.editor
}

func (h *descriptionHub) leave(room string, client *descriptionClient) {
	h.mu.Lock()
	delete(h.rooms[room], client)
	if len(h.rooms[room]) == 0 {
		delete(h.rooms, room)
	}
	h.mu.Unlock()
	client.close()
}

func (h *descriptionHub) broadcast(room string, sender *descriptionClient, frame descriptionFrame) {
	encoded, err := json.Marshal(frame)
	if err != nil {
		return
	}
	h.mu.RLock()
	clients := make([]*descriptionClient, 0, len(h.rooms[room]))
	for client := range h.rooms[room] {
		if client != sender {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()
	for _, client := range clients {
		select {
		case client.send <- encoded:
		case <-client.done:
		default:
			// A stalled peer must not block every collaborator in the room.
			client.close()
		}
	}
}

func (c *descriptionClient) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func (h *Handler) descriptionWebSocket(w http.ResponseWriter, r *http.Request) {
	projectID, taskID, ok := taskPath(w, r)
	if !ok {
		return
	}
	actorID := h.actorID(r)
	task, err := h.service.GetTask(r.Context(), actorID, projectID, taskID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4 * 1024,
		WriteBufferSize: 4 * 1024,
		CheckOrigin:     h.websocketOriginAllowed,
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &descriptionClient{conn: conn, send: make(chan []byte, 32), done: make(chan struct{})}
	room := projectID + ":" + taskID
	canEdit := h.descriptionHub.join(room, client)
	defer h.descriptionHub.leave(room, client)
	go descriptionWriter(client)

	// Join the room before reading the durable document. An update racing with
	// bootstrap is then present either in this database read or in the client's
	// send queue (and Yjs makes applying it through both paths idempotent).
	document, err := h.service.GetTaskDescriptionDocument(r.Context(), actorID, projectID, taskID)
	if err != nil {
		_ = client.sendJSON(descriptionFrame{Type: "error", Error: "DESCRIPTION_BOOTSTRAP_FAILED"})
		return
	}

	bootstrap := descriptionFrame{Type: "bootstrap", Initialized: document.Initialized, Text: task.Description, ReadOnly: !canEdit}
	if document.Initialized {
		bootstrap.Snapshot = base64.StdEncoding.EncodeToString(document.Snapshot)
	} else {
		bootstrap.Text = task.Description
	}
	for _, update := range document.Updates {
		bootstrap.Updates = append(bootstrap.Updates, base64.StdEncoding.EncodeToString(update))
	}
	if err := client.sendJSON(bootstrap); err != nil {
		return
	}

	conn.SetReadLimit(descriptionMaxFrame)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	for {
		_, raw, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		var frame descriptionFrame
		if err := json.Unmarshal(raw, &frame); err != nil || (frame.Type != "init" && frame.Type != "update") || frame.Update == "" {
			_ = client.sendJSON(descriptionFrame{Type: "error", Error: "Expected an init or update frame with a base64 Yjs update."})
			continue
		}
		update, decodeErr := base64.StdEncoding.DecodeString(frame.Update)
		if decodeErr != nil || len(update) == 0 || len(update) > descriptionMaxFrame {
			_ = client.sendJSON(descriptionFrame{Type: "error", MessageID: frame.MessageID, Error: "The Yjs update is not valid base64 or exceeds the 2 MB limit."})
			continue
		}
		if !client.editor {
			_ = client.sendJSON(descriptionFrame{Type: "error", MessageID: frame.MessageID, Error: "DESCRIPTION_EDITOR_LIMIT_REACHED"})
			continue
		}
		messageID := frame.MessageID
		if !validUUID(messageID) {
			messageID = uuid.Must(uuid.NewV7()).String()
		}
		digest := sha256.Sum256(append(append([]byte(frame.Type+"\n"), update...), []byte("\n"+frame.Text)...))
		result, persistErr := h.service.PersistTaskDescriptionUpdate(r.Context(), app.MutationMeta{
			ActorID: actorID, RequestID: uuid.Must(uuid.NewV7()).String(), IdempotencyKey: messageID, RequestHash: digest[:],
		}, projectID, taskID, frame.Text, update, frame.Type == "init")
		if persistErr != nil {
			code := "DESCRIPTION_SYNC_FAILED"
			var domainErr *domain.Error
			if errors.As(persistErr, &domainErr) {
				code = domainErr.Code
			}
			_ = client.sendJSON(descriptionFrame{Type: "error", MessageID: messageID, Error: code})
			continue
		}
		_ = client.sendJSON(descriptionFrame{Type: "ack", MessageID: messageID, Version: result.Value.Version})
		h.descriptionHub.broadcast(room, client, descriptionFrame{Type: "update", Update: frame.Update, Text: frame.Text, ActorID: actorID})
	}
}

func (h *Handler) websocketOriginAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if _, wildcard := h.allowedOrigins["*"]; wildcard {
		return true
	}
	_, allowed := h.allowedOrigins[origin]
	return allowed
}

func descriptionWriter(client *descriptionClient) {
	ticker := time.NewTicker(descriptionPingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-client.done:
			return
		case <-ticker.C:
			_ = client.conn.SetWriteDeadline(time.Now().Add(descriptionWriteWait))
			if err := client.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(descriptionWriteWait)); err != nil {
				client.close()
				return
			}
		case payload := <-client.send:
			_ = client.conn.SetWriteDeadline(time.Now().Add(descriptionWriteWait))
			if err := client.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				client.close()
				return
			}
		}
	}
}

func (c *descriptionClient) sendJSON(frame descriptionFrame) error {
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	select {
	case c.send <- payload:
		return nil
	case <-c.done:
		return errors.New("description client is closed")
	default:
		return errors.New("description client queue is full")
	}
}
