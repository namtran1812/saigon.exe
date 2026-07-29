CREATE TABLE IF NOT EXISTS queues (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    video_id TEXT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    thumbnail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS queue_items (
    queue_id UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (queue_id, track_id),

    CONSTRAINT queue_items_position_nonnegative
        CHECK (position >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS queue_items_queue_position_idx
    ON queue_items(queue_id, position);

CREATE INDEX IF NOT EXISTS queue_items_queue_idx
    ON queue_items(queue_id);
