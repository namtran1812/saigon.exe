package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type QueueTrack struct {
	ID        string `json:"id"`
	VideoID   string `json:"videoId,omitempty"`
	Title     string `json:"title"`
	Artist    string `json:"artist"`
	Thumbnail string `json:"thumbnail,omitempty"`
	Position  int    `json:"position"`
}

type QueueResponse struct {
	ID      string       `json:"id"`
	Version int64        `json:"version"`
	Tracks  []QueueTrack `json:"tracks"`
}

type addTrackRequest struct {
	ID              string `json:"id"`
	VideoID         string `json:"videoId"`
	Title           string `json:"title"`
	Artist          string `json:"artist"`
	Thumbnail       string `json:"thumbnail"`
	ExpectedVersion int64  `json:"expectedVersion"`
}

type reorderQueueRequest struct {
	TrackIDs        []string `json:"trackIds"`
	ExpectedVersion int64    `json:"expectedVersion"`
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(payload); err != nil {
		logHTTPEncodeError(err)
	}
}

func logHTTPEncodeError(err error) {
	// Intentionally small for now; we'll replace this with structured
	// logging/observability later.
	_ = err
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_json",
		})
		return false
	}

	return true
}

func getQueue(ctx context.Context, db *pgxpool.Pool, queueID string) (QueueResponse, error) {
	var response QueueResponse

	err := db.QueryRow(
		ctx,
		`SELECT id::text, version
		 FROM queues
		 WHERE id = $1`,
		queueID,
	).Scan(&response.ID, &response.Version)

	if err != nil {
		return QueueResponse{}, err
	}

	rows, err := db.Query(
		ctx,
		`SELECT
			t.id,
			COALESCE(t.video_id, ''),
			t.title,
			t.artist,
			COALESCE(t.thumbnail, ''),
			qi.position
		 FROM queue_items qi
		 JOIN tracks t ON t.id = qi.track_id
		 WHERE qi.queue_id = $1
		 ORDER BY qi.position ASC`,
		queueID,
	)
	if err != nil {
		return QueueResponse{}, err
	}
	defer rows.Close()

	response.Tracks = []QueueTrack{}

	for rows.Next() {
		var track QueueTrack

		if err := rows.Scan(
			&track.ID,
			&track.VideoID,
			&track.Title,
			&track.Artist,
			&track.Thumbnail,
			&track.Position,
		); err != nil {
			return QueueResponse{}, err
		}

		response.Tracks = append(response.Tracks, track)
	}

	if err := rows.Err(); err != nil {
		return QueueResponse{}, err
	}

	return response, nil
}

func createQueueHandler(
	db *pgxpool.Pool,
	hub *RoomHub,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var queue QueueResponse

		err := db.QueryRow(
			r.Context(),
			`INSERT INTO queues (id)
			 VALUES (gen_random_uuid())
			 RETURNING id::text, version`,
		).Scan(&queue.ID, &queue.Version)

		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "queue_create_failed",
			})
			return
		}

		queue.Tracks = []QueueTrack{}

		writeJSON(w, http.StatusCreated, queue)
	}
}

func queueHandler(
	db *pgxpool.Pool,
	hub *RoomHub,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/queues/")
		parts := strings.Split(strings.Trim(path, "/"), "/")

		if len(parts) == 0 || parts[0] == "" {
			http.NotFound(w, r)
			return
		}

		queueID := parts[0]

		if len(parts) == 1 && r.Method == http.MethodGet {
			queue, err := getQueue(r.Context(), db, queueID)

			if errors.Is(err, pgx.ErrNoRows) {
				writeJSON(w, http.StatusNotFound, map[string]string{
					"error": "queue_not_found",
				})
				return
			}

			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{
					"error": "queue_read_failed",
				})
				return
			}

			writeJSON(w, http.StatusOK, queue)
			return
		}

		if len(parts) == 2 && parts[1] == "tracks" && r.Method == http.MethodPost {
			addTrackHandler(db, hub, queueID, w, r)
			return
		}

		if len(parts) == 2 && parts[1] == "reorder" && r.Method == http.MethodPatch {
			reorderQueueHandler(db, hub, queueID, w, r)
			return
		}

		if len(parts) == 3 && parts[1] == "tracks" && r.Method == http.MethodDelete {
			deleteTrackHandler(db, hub, queueID, parts[2], w, r)
			return
		}

		http.NotFound(w, r)
	}
}

func addTrackHandler(
	db *pgxpool.Pool,
	hub *RoomHub,
	queueID string,
	w http.ResponseWriter,
	r *http.Request,
) {
	var req addTrackRequest

	if !readJSON(w, r, &req) {
		return
	}

	if req.ID == "" || req.Title == "" || req.Artist == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "missing_track_fields",
		})
		return
	}

	tx, err := db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "transaction_failed",
		})
		return
	}
	defer tx.Rollback(r.Context())

	var currentVersion int64

	err = tx.QueryRow(
		r.Context(),
		`SELECT version
		 FROM queues
		 WHERE id = $1
		 FOR UPDATE`,
		queueID,
	).Scan(&currentVersion)

	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "queue_not_found",
		})
		return
	}

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_lock_failed",
		})
		return
	}

	if currentVersion != req.ExpectedVersion {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":          "version_conflict",
			"currentVersion": currentVersion,
		})
		return
	}

	_, err = tx.Exec(
		r.Context(),
		`INSERT INTO tracks (
			id,
			video_id,
			title,
			artist,
			thumbnail
		)
		 VALUES ($1, NULLIF($2, ''), $3, $4, NULLIF($5, ''))
		 ON CONFLICT (id) DO UPDATE SET
			video_id = EXCLUDED.video_id,
			title = EXCLUDED.title,
			artist = EXCLUDED.artist,
			thumbnail = EXCLUDED.thumbnail`,
		req.ID,
		req.VideoID,
		req.Title,
		req.Artist,
		req.Thumbnail,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "track_upsert_failed",
		})
		return
	}

	var nextPosition int

	err = tx.QueryRow(
		r.Context(),
		`SELECT COALESCE(MAX(position) + 1, 0)
		 FROM queue_items
		 WHERE queue_id = $1`,
		queueID,
	).Scan(&nextPosition)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_position_failed",
		})
		return
	}

	_, err = tx.Exec(
		r.Context(),
		`INSERT INTO queue_items (
			queue_id,
			track_id,
			position
		)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (queue_id, track_id) DO NOTHING`,
		queueID,
		req.ID,
		nextPosition,
	)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_add_failed",
		})
		return
	}

	var nextVersion int64

	err = tx.QueryRow(
		r.Context(),
		`UPDATE queues
		 SET version = version + 1,
		     updated_at = NOW()
		 WHERE id = $1
		 RETURNING version`,
		queueID,
	).Scan(&nextVersion)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_version_failed",
		})
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "transaction_commit_failed",
		})
		return
	}

	queue, err := getQueue(r.Context(), db, queueID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_read_failed",
		})
		return
	}

	queue.Version = nextVersion
	broadcastQueueUpdate(hub, r, queue)
	writeJSON(w, http.StatusOK, queue)
}

func reorderQueueHandler(
	db *pgxpool.Pool,
	hub *RoomHub,
	queueID string,
	w http.ResponseWriter,
	r *http.Request,
) {
	var req reorderQueueRequest

	if !readJSON(w, r, &req) {
		return
	}

	tx, err := db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "transaction_failed",
		})
		return
	}
	defer tx.Rollback(r.Context())

	var currentVersion int64

	err = tx.QueryRow(
		r.Context(),
		`SELECT version
		 FROM queues
		 WHERE id = $1
		 FOR UPDATE`,
		queueID,
	).Scan(&currentVersion)

	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "queue_not_found",
		})
		return
	}

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_lock_failed",
		})
		return
	}

	if currentVersion != req.ExpectedVersion {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":          "version_conflict",
			"currentVersion": currentVersion,
		})
		return
	}

	var itemCount int

	if err := tx.QueryRow(
		r.Context(),
		`SELECT COUNT(*)
		 FROM queue_items
		 WHERE queue_id = $1`,
		queueID,
	).Scan(&itemCount); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_count_failed",
		})
		return
	}

	if len(req.TrackIDs) != itemCount {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "reorder_must_include_all_tracks",
		})
		return
	}

	seen := make(map[string]struct{}, len(req.TrackIDs))

	for position, trackID := range req.TrackIDs {
		if _, exists := seen[trackID]; exists {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "duplicate_track_id",
			})
			return
		}

		seen[trackID] = struct{}{}

		tag, err := tx.Exec(
			r.Context(),
			`UPDATE queue_items
			 SET position = $1 + 1000000
			 WHERE queue_id = $2
			   AND track_id = $3`,
			position,
			queueID,
			trackID,
		)

		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "queue_reorder_failed",
			})
			return
		}

		if tag.RowsAffected() != 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "unknown_track_id",
			})
			return
		}
	}

	for position, trackID := range req.TrackIDs {
		_, err := tx.Exec(
			r.Context(),
			`UPDATE queue_items
			 SET position = $1
			 WHERE queue_id = $2
			   AND track_id = $3`,
			position,
			queueID,
			trackID,
		)

		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "queue_reorder_failed",
			})
			return
		}
	}

	_, err = tx.Exec(
		r.Context(),
		`UPDATE queues
		 SET version = version + 1,
		     updated_at = NOW()
		 WHERE id = $1`,
		queueID,
	)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_version_failed",
		})
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "transaction_commit_failed",
		})
		return
	}

	queue, err := getQueue(r.Context(), db, queueID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_read_failed",
		})
		return
	}

	broadcastQueueUpdate(hub, r, queue)
	writeJSON(w, http.StatusOK, queue)
}

func deleteTrackHandler(
	db *pgxpool.Pool,
	hub *RoomHub,
	queueID string,
	trackID string,
	w http.ResponseWriter,
	r *http.Request,
) {
	versionString := r.URL.Query().Get("expectedVersion")

	expectedVersion, err := strconv.ParseInt(versionString, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_expected_version",
		})
		return
	}

	tx, err := db.Begin(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "transaction_failed",
		})
		return
	}
	defer tx.Rollback(r.Context())

	var currentVersion int64

	err = tx.QueryRow(
		r.Context(),
		`SELECT version
		 FROM queues
		 WHERE id = $1
		 FOR UPDATE`,
		queueID,
	).Scan(&currentVersion)

	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "queue_not_found",
		})
		return
	}

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_lock_failed",
		})
		return
	}

	if currentVersion != expectedVersion {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":          "version_conflict",
			"currentVersion": currentVersion,
		})
		return
	}

	tag, err := tx.Exec(
		r.Context(),
		`DELETE FROM queue_items
		 WHERE queue_id = $1
		   AND track_id = $2`,
		queueID,
		trackID,
	)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_delete_failed",
		})
		return
	}

	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "track_not_in_queue",
		})
		return
	}

	_, err = tx.Exec(
		r.Context(),
		`WITH ordered AS (
			SELECT track_id,
			       ROW_NUMBER() OVER (ORDER BY position) - 1 AS next_position
			FROM queue_items
			WHERE queue_id = $1
		)
		 UPDATE queue_items qi
		 SET position = ordered.next_position + 1000000
		 FROM ordered
		 WHERE qi.queue_id = $1
		   AND qi.track_id = ordered.track_id`,
		queueID,
	)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_reindex_failed",
		})
		return
	}

	_, err = tx.Exec(
		r.Context(),
		`UPDATE queue_items
		 SET position = position - 1000000
		 WHERE queue_id = $1`,
		queueID,
	)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_reindex_failed",
		})
		return
	}

	_, err = tx.Exec(
		r.Context(),
		`UPDATE queues
		 SET version = version + 1,
		     updated_at = NOW()
		 WHERE id = $1`,
		queueID,
	)

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_version_failed",
		})
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "transaction_commit_failed",
		})
		return
	}

	queue, err := getQueue(r.Context(), db, queueID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "queue_read_failed",
		})
		return
	}

	broadcastQueueUpdate(hub, r, queue)
	writeJSON(w, http.StatusOK, queue)
}

func broadcastQueueUpdate(
	hub *RoomHub,
	r *http.Request,
	queue QueueResponse,
) {
	roomID := strings.TrimSpace(
		r.URL.Query().Get("room"),
	)

	if roomID == "" {
		return
	}

	hub.BroadcastJSON(roomID, map[string]any{
		"type":    "queue.updated",
		"roomId":  roomID,
		"version": queue.Version,
		"payload": queue,
	})
}
