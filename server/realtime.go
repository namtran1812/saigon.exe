package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type RoomEvent struct {
	Type    string          `json:"type"`
	RoomID  string          `json:"roomId"`
	Version int64           `json:"version,omitempty"`
	SentAt  int64           `json:"sentAt,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type roomClient struct {
	conn *websocket.Conn
	send chan []byte
}

type room struct {
	mu      sync.RWMutex
	clients map[*roomClient]struct{}

	queueSnapshot json.RawMessage
	playback      *RoomEvent

	cancelSubscription context.CancelFunc
}

type RoomHub struct {
	mu    sync.RWMutex
	rooms map[string]*room

	redis      *RedisRealtime
	instanceID string
}

func NewRoomHub(
	redisRealtime *RedisRealtime,
	instanceID string,
) *RoomHub {
	return &RoomHub{
		rooms:      make(map[string]*room),
		redis:      redisRealtime,
		instanceID: instanceID,
	}
}

func (h *RoomHub) getRoom(roomID string) *room {
	h.mu.Lock()
	defer h.mu.Unlock()

	r, ok := h.rooms[roomID]
	if !ok {
		r = &room{
			clients: make(map[*roomClient]struct{}),
		}

		h.rooms[roomID] = r

		go h.startRedisSubscription(
			roomID,
			r,
		)
	}

	return r
}

func (h *RoomHub) removeClient(
	roomID string,
	client *roomClient,
) {
	h.mu.Lock()
	defer h.mu.Unlock()

	r, ok := h.rooms[roomID]
	if !ok {
		return
	}

	r.mu.Lock()
	delete(r.clients, client)
	empty := len(r.clients) == 0
	r.mu.Unlock()

	if empty {
		if r.cancelSubscription != nil {
			r.cancelSubscription()
			r.cancelSubscription = nil
		}

		delete(h.rooms, roomID)
	}
}

func (h *RoomHub) broadcast(
	roomID string,
	message []byte,
	sender *roomClient,
) {
	h.mu.RLock()
	r := h.rooms[roomID]
	h.mu.RUnlock()

	if r == nil {
		return
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	for client := range r.clients {
		if client == sender {
			continue
		}

		select {
		case client.send <- message:
		default:
			// Never let one slow browser block the room.
		}
	}
}

func (h *RoomHub) recordEvent(
	roomID string,
	event RoomEvent,
) {
	r := h.getRoom(roomID)

	r.mu.Lock()
	defer r.mu.Unlock()

	switch event.Type {
	case "queue.updated":
		r.queueSnapshot = append(
			json.RawMessage(nil),
			event.Payload...,
		)

	case "playback.state", "playback.track":
		copyEvent := event
		copyEvent.Payload = append(
			json.RawMessage(nil),
			event.Payload...,
		)

		r.playback = &copyEvent
	}
}

func (h *RoomHub) snapshotMessage(
	roomID string,
) []byte {
	h.mu.RLock()
	r := h.rooms[roomID]
	h.mu.RUnlock()

	if r == nil {
		return nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	payload := map[string]any{}

	if len(r.queueSnapshot) > 0 {
		payload["queue"] = json.RawMessage(
			append(
				json.RawMessage(nil),
				r.queueSnapshot...,
			),
		)
	}

	if r.playback != nil {
		payload["playback"] = r.playback
	}

	if len(payload) == 0 {
		return nil
	}

	message, err := json.Marshal(map[string]any{
		"type":    "room.snapshot",
		"roomId":  roomID,
		"sentAt":  time.Now().UnixMilli(),
		"payload": payload,
	})
	if err != nil {
		return nil
	}

	return message
}

func (h *RoomHub) startRedisSubscription(
	roomID string,
	r *room,
) {
	if h.redis == nil {
		return
	}

	ctx, cancel := context.WithCancel(
		context.Background(),
	)

	r.mu.Lock()

	if r.cancelSubscription != nil {
		r.mu.Unlock()
		cancel()
		return
	}

	r.cancelSubscription = cancel
	r.mu.Unlock()

	pubsub := h.redis.Subscribe(ctx, roomID)

	go func() {
		defer pubsub.Close()

		channel := pubsub.Channel()

		for {
			select {
			case <-ctx.Done():
				return

			case message, ok := <-channel:
				if !ok {
					return
				}

				var envelope RedisRoomEnvelope

				if err := json.Unmarshal(
					[]byte(message.Payload),
					&envelope,
				); err != nil {
					continue
				}

				/*
				 * Redis also sends our own published event
				 * back to this process. Ignore that copy
				 * because we already delivered it locally.
				 */
				if envelope.InstanceID == h.instanceID {
					continue
				}

				eventBytes, err := json.Marshal(
					envelope.Event,
				)
				if err != nil {
					continue
				}

				h.recordEvent(
					roomID,
					envelope.Event,
				)

				h.broadcast(
					roomID,
					eventBytes,
					nil,
				)
			}
		}
	}()
}

func (h *RoomHub) serveWS(
	w http.ResponseWriter,
	r *http.Request,
) {
	roomID := strings.TrimSpace(
		r.URL.Query().Get("room"),
	)

	if roomID == "" || len(roomID) > 64 {
		http.Error(
			w,
			"invalid room",
			http.StatusBadRequest,
		)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Tighten this before production deployment.
		OriginPatterns: []string{
			"localhost:*",
			"127.0.0.1:*",
		},
	})
	if err != nil {
		log.Printf("websocket accept: %v", err)
		return
	}

	client := &roomClient{
		conn: conn,
		send: make(chan []byte, 32),
	}

	room := h.getRoom(roomID)

	room.mu.Lock()
	room.clients[client] = struct{}{}
	room.mu.Unlock()

	defer func() {
		h.removeClient(roomID, client)
		_ = conn.Close(
			websocket.StatusNormalClosure,
			"",
		)
	}()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		defer cancel()

		for {
			select {
			case <-ctx.Done():
				return

			case message := <-client.send:
				writeCtx, writeCancel :=
					context.WithTimeout(ctx, 5*time.Second)

				err := conn.Write(
					writeCtx,
					websocket.MessageText,
					message,
				)

				writeCancel()

				if err != nil {
					return
				}
			}
		}
	}()

	joined, _ := json.Marshal(map[string]any{
		"type":   "room.joined",
		"roomId": roomID,
	})

	if err := conn.Write(
		ctx,
		websocket.MessageText,
		joined,
	); err != nil {
		return
	}

	if snapshot := h.snapshotMessage(roomID); snapshot != nil {
		if err := conn.Write(
			ctx,
			websocket.MessageText,
			snapshot,
		); err != nil {
			return
		}
	}

	for {
		_, message, err := conn.Read(ctx)
		if err != nil {
			return
		}

		var event RoomEvent

		if err := json.Unmarshal(message, &event); err != nil {
			continue
		}

		// A client may only publish into the room it joined.
		event.RoomID = roomID

		if event.SentAt == 0 {
			event.SentAt = time.Now().UnixMilli()
		}

		h.recordEvent(roomID, event)

		if h.redis != nil {
			if err := h.redis.SaveEvent(
				ctx,
				roomID,
				event,
			); err != nil {
				log.Printf(
					"redis save event: %v",
					err,
				)
			}

			if err := h.redis.PublishEnvelope(
				ctx,
				roomID,
				RedisRoomEnvelope{
					InstanceID: h.instanceID,
					Event:      event,
				},
			); err != nil {
				log.Printf(
					"redis publish: %v",
					err,
				)
			}
		}

		message, err = json.Marshal(event)
		if err != nil {
			continue
		}

		h.broadcast(roomID, message, client)
	}
}

func (h *RoomHub) BroadcastJSON(
	roomID string,
	event any,
) {
	message, err := json.Marshal(event)
	if err != nil {
		return
	}

	var roomEvent RoomEvent

	if err := json.Unmarshal(message, &roomEvent); err == nil {
		roomEvent.RoomID = roomID

		if roomEvent.SentAt == 0 {
			roomEvent.SentAt = time.Now().UnixMilli()
		}

		h.recordEvent(roomID, roomEvent)

		message, err = json.Marshal(roomEvent)
		if err != nil {
			return
		}
	}

	if h.redis != nil {
		ctx, cancel := context.WithTimeout(
			context.Background(),
			2*time.Second,
		)

		if err := h.redis.SaveEvent(
			ctx,
			roomID,
			roomEvent,
		); err != nil {
			log.Printf(
				"redis save server event: %v",
				err,
			)
		}

		if err := h.redis.PublishEnvelope(
			ctx,
			roomID,
			RedisRoomEnvelope{
				InstanceID: h.instanceID,
				Event:      roomEvent,
			},
		); err != nil {
			log.Printf(
				"redis publish server event: %v",
				err,
			)
		}

		cancel()
	}

	h.broadcast(roomID, message, nil)
}
