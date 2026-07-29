package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisRealtime struct {
	client *redis.Client
}

func NewRedisRealtime(addr string) *RedisRealtime {
	return &RedisRealtime{
		client: redis.NewClient(&redis.Options{
			Addr: addr,
		}),
	}
}

func (r *RedisRealtime) Ping(ctx context.Context) error {
	return r.client.Ping(ctx).Err()
}

func (r *RedisRealtime) Close() error {
	return r.client.Close()
}

func roomChannel(roomID string) string {
	return fmt.Sprintf("saigon:room:%s:events", roomID)
}

func roomPlaybackKey(roomID string) string {
	return fmt.Sprintf("saigon:room:%s:playback", roomID)
}

func roomQueueKey(roomID string) string {
	return fmt.Sprintf("saigon:room:%s:queue", roomID)
}

func (r *RedisRealtime) Publish(
	ctx context.Context,
	roomID string,
	event RoomEvent,
) error {
	message, err := json.Marshal(event)
	if err != nil {
		return err
	}

	return r.client.Publish(
		ctx,
		roomChannel(roomID),
		message,
	).Err()
}

func (r *RedisRealtime) SaveEvent(
	ctx context.Context,
	roomID string,
	event RoomEvent,
) error {
	var key string

	switch event.Type {
	case "queue.updated":
		key = roomQueueKey(roomID)

	case "playback.state", "playback.track":
		key = roomPlaybackKey(roomID)

	default:
		return nil
	}

	message, err := json.Marshal(event)
	if err != nil {
		return err
	}

	return r.client.Set(
		ctx,
		key,
		message,
		24*time.Hour,
	).Err()
}

func (r *RedisRealtime) LoadSnapshot(
	ctx context.Context,
	roomID string,
) (map[string]any, error) {
	snapshot := map[string]any{}

	queueValue, err := r.client.Get(
		ctx,
		roomQueueKey(roomID),
	).Bytes()

	if err == nil {
		var event RoomEvent

		if json.Unmarshal(queueValue, &event) == nil {
			snapshot["queue"] = event.Payload
		}
	} else if err != redis.Nil {
		return nil, err
	}

	playbackValue, err := r.client.Get(
		ctx,
		roomPlaybackKey(roomID),
	).Bytes()

	if err == nil {
		var event RoomEvent

		if json.Unmarshal(playbackValue, &event) == nil {
			snapshot["playback"] = event
		}
	} else if err != redis.Nil {
		return nil, err
	}

	return snapshot, nil
}

func (r *RedisRealtime) Subscribe(
	ctx context.Context,
	roomID string,
) *redis.PubSub {
	return r.client.Subscribe(
		ctx,
		roomChannel(roomID),
	)
}

type RedisRoomEnvelope struct {
	InstanceID string    `json:"instanceId"`
	Event      RoomEvent `json:"event"`
}

func (r *RedisRealtime) PublishEnvelope(
	ctx context.Context,
	roomID string,
	envelope RedisRoomEnvelope,
) error {
	message, err := json.Marshal(envelope)
	if err != nil {
		return err
	}

	return r.client.Publish(
		ctx,
		roomChannel(roomID),
		message,
	).Err()
}
