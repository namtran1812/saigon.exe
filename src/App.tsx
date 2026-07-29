import { useEffect, useRef, useState } from "react";
import "./App.css";

type ModeId = "quan-ho" | "nha-nhac" | "cai-luong" | "don-ca-tai-tu";

type Mode = {
  id: ModeId;
  number: string;
  shortLabel: string;
  label: string;
  subtitle: string;
  scenery?: string;
  stage: string;
  figure: string;
};

const MODES: Mode[] = [
  {
    id: "quan-ho",
    number: "01",
    shortLabel: "QUAN HỌ",
    label: "QUAN HỌ",
    subtitle: "BẮC NINH",
    scenery: "/assets/quan-ho-background.png",
    stage: "/assets/quan-ho-stage.png",
    figure: "/assets/quan-ho-girl.png",
  },
  {
    id: "nha-nhac",
    number: "02",
    shortLabel: "NHÃ NHẠC",
    label: "NHÃ NHẠC CUNG ĐÌNH",
    subtitle: "HUẾ",
    stage: "/assets/nha-nhac-cung-dinh-stage.png",
    figure: "/assets/nha-nhac-cung-dinh-girl.png",
  },
  {
    id: "cai-luong",
    number: "03",
    shortLabel: "CẢI LƯƠNG",
    label: "CẢI LƯƠNG",
    subtitle: "NAM BỘ",
    stage: "/assets/cai-luong-stage.png",
    figure: "/assets/cai-luong-girl.png",
  },
  {
    id: "don-ca-tai-tu",
    number: "04",
    shortLabel: "ĐỜN CA",
    label: "ĐỜN CA TÀI TỬ",
    subtitle: "NAM BỘ",
    stage: "/assets/don-ca-tai-tu-stage.png",
    figure: "/assets/don-ca-tai-tu-girl.png",
  },
];

type MediaTrack = {
  id: string;
  title: string;
  artist: string;
  videoId?: string;
};

type ServerQueue = {
  id: string;
  version: number;
  tracks: Array<MediaTrack & {
    position: number;
  }>;
};

type YouTubeRecommendation = {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
};

const INITIAL_MEDIA_QUEUE: MediaTrack[] = [];


type YouTubePlayerInstance = {
  playVideo: () => void;
  pauseVideo: () => void;
  cueVideoById: (videoId: string) => void;
  loadVideoById: (videoId: string) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  destroy: () => void;
};

type YouTubeAPI = {
  Player: new (
    elementId: string,
    options: {
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
      };
    }
  ) => YouTubePlayerInstance;
};

declare global {
  interface Window {
    YT?: YouTubeAPI;
    onYouTubeIframeAPIReady?: () => void;
  }
}


const SAIGON_QUEUE_STORAGE_KEY = "saigon.exe.mediaQueue";
const SAIGON_SERVER_QUEUE_ID_KEY = "saigon.exe.serverQueueId";
const SAIGON_ROOM_STORAGE_KEY = "saigon.exe.roomId";
const SAIGON_TRACK_STORAGE_KEY = "saigon.exe.currentTrack";
const SAIGON_REPEAT_STORAGE_KEY = "saigon.exe.repeatMode";
const SAIGON_SHUFFLE_STORAGE_KEY = "saigon.exe.shuffle";

function loadSavedQueue(): MediaTrack[] {
  try {
    const raw = localStorage.getItem(SAIGON_QUEUE_STORAGE_KEY);

    if (!raw) return INITIAL_MEDIA_QUEUE;

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return INITIAL_MEDIA_QUEUE;
    }

    return parsed.filter(
      (track): track is MediaTrack =>
        track &&
        typeof track.id === "string" &&
        typeof track.title === "string" &&
        typeof track.artist === "string"
    );
  } catch {
    return INITIAL_MEDIA_QUEUE;
  }
}

function loadSavedTrackId(): string | null {
  try {
    return localStorage.getItem(SAIGON_TRACK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function loadSavedRepeatMode(): "off" | "all" | "one" {
  try {
    const value = localStorage.getItem(SAIGON_REPEAT_STORAGE_KEY);

    if (value === "off" || value === "all" || value === "one") {
      return value;
    }
  } catch {
    // Ignore unavailable storage.
  }

  return "all";
}

function loadSavedShuffle(): boolean {
  try {
    return localStorage.getItem(SAIGON_SHUFFLE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}


const DEFAULT_DURATION_SECONDS = 0;


function formatMediaTime(totalSeconds: number) {
  const safe = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : 0;

  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function splitTime(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    hours: String(hours).padStart(2, "0"),
    minutes: String(minutes).padStart(2, "0"),
    seconds: String(seconds).padStart(2, "0"),
  };
}



class QueueAPIError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "QueueAPIError";
    this.status = status;
  }
}

async function createServerQueue(): Promise<ServerQueue> {
  const response = await fetch("/api/queues", {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      `create queue failed: ${response.status}`
    );
  }

  return response.json();
}

async function fetchServerQueue(
  queueId: string
): Promise<ServerQueue> {
  const response = await fetch(
    `/api/queues/${encodeURIComponent(queueId)}`
  );

  if (!response.ok) {
    throw new Error(
      `fetch queue failed: ${response.status}`
    );
  }

  return response.json();
}

async function addTrackToServerQueue(
  queueId: string,
  version: number,
  track: MediaTrack,
  roomId?: string
): Promise<ServerQueue> {
  const response = await fetch(
    `/api/queues/${encodeURIComponent(queueId)}/tracks?room=${encodeURIComponent(roomId ?? "")}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...track,
        expectedVersion: version,
      }),
    }
  );

  if (!response.ok) {
    throw new QueueAPIError(
      response.status,
      `add track failed: ${response.status}`
    );
  }

  return response.json();
}

async function removeTrackFromServerQueue(
  queueId: string,
  version: number,
  trackId: string,
  roomId?: string
): Promise<ServerQueue> {
  const response = await fetch(
    `/api/queues/${encodeURIComponent(queueId)}/tracks/${encodeURIComponent(trackId)}?expectedVersion=${version}&room=${encodeURIComponent(roomId ?? "")}`,
    {
      method: "DELETE",
    }
  );

  if (!response.ok) {
    throw new QueueAPIError(
      response.status,
      `remove track failed: ${response.status}`
    );
  }

  return response.json();
}

async function reorderServerQueue(
  queueId: string,
  version: number,
  trackIds: string[],
  roomId?: string
): Promise<ServerQueue> {
  const response = await fetch(
    `/api/queues/${encodeURIComponent(queueId)}/reorder?room=${encodeURIComponent(roomId ?? "")}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        trackIds,
        expectedVersion: version,
      }),
    }
  );

  if (!response.ok) {
    throw new QueueAPIError(
      response.status,
      `reorder queue failed: ${response.status}`
    );
  }

  return response.json();
}


async function addTrackWithRetry(
  queueId: string,
  version: number,
  track: MediaTrack,
  roomId?: string
): Promise<ServerQueue> {
  try {
    return await addTrackToServerQueue(
      queueId,
      version,
      track,
      roomId
    );
  } catch (error) {
    if (!(error instanceof QueueAPIError) || error.status !== 409) {
      throw error;
    }

    const latest = await fetchServerQueue(queueId);

    if (latest.tracks.some((item) => item.id === track.id)) {
      return latest;
    }

    return addTrackToServerQueue(
      queueId,
      latest.version,
      track,
      roomId
    );
  }
}

async function removeTrackWithRetry(
  queueId: string,
  version: number,
  trackId: string,
  roomId?: string
): Promise<ServerQueue> {
  try {
    return await removeTrackFromServerQueue(
      queueId,
      version,
      trackId,
      roomId
    );
  } catch (error) {
    if (!(error instanceof QueueAPIError) || error.status !== 409) {
      throw error;
    }

    const latest = await fetchServerQueue(queueId);

    if (!latest.tracks.some((item) => item.id === trackId)) {
      return latest;
    }

    return removeTrackFromServerQueue(
      queueId,
      latest.version,
      trackId,
      roomId
    );
  }
}

async function reorderQueueWithRetry(
  queueId: string,
  version: number,
  trackIds: string[],
  roomId?: string
): Promise<ServerQueue> {
  try {
    return await reorderServerQueue(
      queueId,
      version,
      trackIds,
      roomId
    );
  } catch (error) {
    if (!(error instanceof QueueAPIError) || error.status !== 409) {
      throw error;
    }

    const latest = await fetchServerQueue(queueId);

    /*
     * Reordering only makes sense if both clients still
     * contain exactly the same track set.
     */
    const latestIds = latest.tracks.map((track) => track.id);

    const sameTracks =
      latestIds.length === trackIds.length &&
      latestIds.every((id) => trackIds.includes(id));

    if (!sameTracks) {
      return latest;
    }

    return reorderServerQueue(
      queueId,
      latest.version,
      trackIds,
      roomId
    );
  }
}

export default function App() {
  const [modeIndex, setModeIndex] = useState(0);
  const [duration, setDuration] = useState(DEFAULT_DURATION_SECONDS);
  const [timerHours, setTimerHours] = useState("00");
  const [timerMinutes, setTimerMinutes] = useState("00");
  const [timerSeconds, setTimerSeconds] = useState("00");
  const [remaining, setRemaining] = useState(DEFAULT_DURATION_SECONDS);
  const [running, setRunning] = useState(false);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [serverQueueId, setServerQueueId] =
    useState<string | null>(null);

  const [serverQueueVersion, setServerQueueVersion] =
    useState<number | null>(null);

  const [serverQueueReady, setServerQueueReady] =
    useState(false);

  const [roomId] = useState(() => {
    try {
      const existing =
        localStorage.getItem(SAIGON_ROOM_STORAGE_KEY);

      if (existing) return existing;

      const created =
        Math.random()
          .toString(36)
          .slice(2, 8)
          .toUpperCase();

      localStorage.setItem(
        SAIGON_ROOM_STORAGE_KEY,
        created
      );

      return created;
    } catch {
      return "LOCAL";
    }
  });
  const [repeatMode, setRepeatMode] =
    useState<"off" | "all" | "one">(() => loadSavedRepeatMode());
  const [shuffleEnabled, setShuffleEnabled] =
    useState(() => loadSavedShuffle());
  const [draggedTrackIndex, setDraggedTrackIndex] =
    useState<number | null>(null);
  const [mediaQueue, setMediaQueue] =
    useState<MediaTrack[]>(() => loadSavedQueue());

  const [recommendations, setRecommendations] =
    useState<YouTubeRecommendation[]>([]);

  const [recommendationsLoading, setRecommendationsLoading] =
    useState(false);

  const [youtubeQuotaExceeded, setYoutubeQuotaExceeded] =
    useState(false);

  /*
   * null = default cultural-mode recommendations.
   * string = recommendations/search centered around that query.
   */
  const [discoveryQuery, setDiscoveryQuery] =
    useState<string | null>(null);

  const [manualSearch, setManualSearch] = useState("");

  const youtubePlayerRef =
    useRef<YouTubePlayerInstance | null>(null);
  const realtimeSocketRef = useRef<WebSocket | null>(null);

  const mediaQueueRef = useRef<MediaTrack[]>([]);
  const currentTrackIndexRef = useRef(0);
  const repeatModeRef =
    useRef<"off" | "all" | "one">("all");
  const shuffleEnabledRef = useRef(false);
  const shuffleBagRef = useRef<number[]>([]);
  const shuffleHistoryRef = useRef<number[]>([]);

  const lcdTitleRef = useRef<HTMLSpanElement | null>(null);
  const lcdTitleFrameRef = useRef<number | null>(null);
  const lcdTitlePositionRef = useRef(0);
  const lcdTitleLastTimeRef = useRef<number | null>(null);

  const recommendationCacheRef =
    useRef<Map<string, YouTubeRecommendation[]>>(new Map());

  const [youtubePlayerReady, setYoutubePlayerReady] =
    useState(false);

  /*
   * True only after YouTube has actually entered PLAYING.
   * Prevents loading/spinner UI from appearing in the sky.
   */
  const [mediaVisualReady, setMediaVisualReady] = useState(false);

  const [mediaCurrentTime, setMediaCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);

  const currentTrack = mediaQueue[currentTrackIndex] ?? null;

  const sendRealtimeEvent = (
    type: string,
    payload: unknown
  ) => {
    const socket = realtimeSocketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type,
        roomId,
        sentAt: Date.now(),
        payload,
      })
    );
  };

  const applyRemotePlayback = (
    payload: {
      playing?: boolean;
      trackId?: string | null;
      position?: number;
    },
    sentAt?: number
  ) => {
    const basePosition =
      typeof payload.position === "number"
        ? payload.position
        : 0;

    const networkDelay =
      payload.playing && typeof sentAt === "number"
        ? Math.max(0, (Date.now() - sentAt) / 1000)
        : 0;

    const targetPosition =
      basePosition + networkDelay;

    const player = youtubePlayerRef.current;

    if (
      player &&
      Number.isFinite(targetPosition)
    ) {
      const localPosition = player.getCurrentTime();

      const drift = Math.abs(
        localPosition - targetPosition
      );

      /*
       * Ignore tiny differences to avoid constant seeking.
       */
      if (drift > 0.75) {
        player.seekTo(targetPosition, true);
      }
    }

    setMediaCurrentTime(targetPosition);

    if (typeof payload.playing === "boolean") {
      setMediaPlaying(payload.playing);
    }
  };

  const applyServerQueue = (queue: ServerQueue) => {
    const activeTrackId = currentTrack?.id;

    const nextTracks = queue.tracks.map(
      ({ position: _position, ...track }) => track
    );

    setServerQueueId(queue.id);
    setServerQueueVersion(queue.version);
    setServerQueueReady(true);
    setMediaQueue(nextTracks);

    if (activeTrackId) {
      const nextIndex = nextTracks.findIndex(
        (track) => track.id === activeTrackId
      );

      if (nextIndex !== -1) {
        setCurrentTrackIndex(nextIndex);
        return;
      }
    }

    if (nextTracks.length === 0) {
      setCurrentTrackIndex(0);
      setMediaPlaying(false);
    } else {
      setCurrentTrackIndex((index) =>
        Math.min(index, nextTracks.length - 1)
      );
    }
  };

  /*
   * Bootstrap durable server queue.
   * PostgreSQL is authoritative when available.
   * Existing localStorage remains the offline fallback.
   */
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const savedQueueId =
          localStorage.getItem(
            SAIGON_SERVER_QUEUE_ID_KEY
          );

        let queue: ServerQueue;

        if (savedQueueId) {
          try {
            queue = await fetchServerQueue(savedQueueId);
          } catch {
            queue = await createServerQueue();
          }
        } else {
          queue = await createServerQueue();
        }

        if (cancelled) return;

        localStorage.setItem(
          SAIGON_SERVER_QUEUE_ID_KEY,
          queue.id
        );

        setServerQueueId(queue.id);
        setServerQueueVersion(queue.version);

        if (queue.tracks.length > 0) {
          /*
           * Existing PostgreSQL state wins.
           */
          setMediaQueue(
            queue.tracks.map(
              ({ position: _position, ...track }) =>
                track
            )
          );
        } else if (mediaQueue.length > 0) {
          /*
           * One-time migration from the old localStorage
           * queue into PostgreSQL.
           */
          let migrated = queue;

          for (const track of mediaQueue) {
            migrated = await addTrackWithRetry(
              migrated.id,
              migrated.version,
              track
            );
          }

          if (!cancelled) {
            setServerQueueVersion(migrated.version);

            setMediaQueue(
              migrated.tracks.map(
                ({ position: _position, ...track }) =>
                  track
              )
            );
          }
        }

        setServerQueueReady(true);
      } catch (error) {
        console.warn(
          "Server queue unavailable; using local queue",
          error
        );

        if (!cancelled) {
          setServerQueueReady(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  mediaQueueRef.current = mediaQueue;
  currentTrackIndexRef.current = currentTrackIndex;
  repeatModeRef.current = repeatMode;
  shuffleEnabledRef.current = shuffleEnabled;

  /*
   * Persist repeat + shuffle preferences.
   */
  useEffect(() => {
    try {
      localStorage.setItem(
        SAIGON_REPEAT_STORAGE_KEY,
        repeatMode
      );
    } catch {
      // Ignore unavailable storage.
    }
  }, [repeatMode]);

  useEffect(() => {
    try {
      localStorage.setItem(
        SAIGON_SHUFFLE_STORAGE_KEY,
        String(shuffleEnabled)
      );
    } catch {
      // Ignore unavailable storage.
    }
  }, [shuffleEnabled]);

  const availableRecommendations = recommendations.filter(
    (recommendation) =>
      !mediaQueue.some(
        (track) => track.videoId === recommendation.id
      )
  );

  /*
   * Restore previously selected queue item after startup.
   */
  useEffect(() => {
    const savedTrackId = loadSavedTrackId();

    if (!savedTrackId || mediaQueue.length === 0) {
      return;
    }

    const index = mediaQueue.findIndex(
      (track) => track.id === savedTrackId
    );

    if (index !== -1) {
      setCurrentTrackIndex(index);
    }
  }, []);


  /*
   * Persist queue changes: adds, removes and drag reordering.
   */
  useEffect(() => {
    try {
      localStorage.setItem(
        SAIGON_QUEUE_STORAGE_KEY,
        JSON.stringify(mediaQueue)
      );
    } catch {
      // Storage may be unavailable in private/restricted environments.
    }
  }, [mediaQueue]);


  /*
   * Persist the active song independently from its queue index,
   * because drag-and-drop can change the index.
   */
  useEffect(() => {
    try {
      if (currentTrack?.id) {
        localStorage.setItem(
          SAIGON_TRACK_STORAGE_KEY,
          currentTrack.id
        );
      } else {
        localStorage.removeItem(
          SAIGON_TRACK_STORAGE_KEY
        );
      }
    } catch {
      // Ignore unavailable storage.
    }
  }, [currentTrack?.id]);

  const mode = MODES[modeIndex];
  const displayTime = splitTime(remaining);

  /*
   * Realtime queue synchronization.
   * REST remains authoritative for writes;
   * WebSocket pushes committed PostgreSQL state to peers.
   */
  useEffect(() => {
    const socket = new WebSocket(
      `/ws?room=${encodeURIComponent(roomId)}`
    );

    realtimeSocketRef.current = socket;

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (
          message.type === "room.snapshot" &&
          message.payload
        ) {
          const snapshot = message.payload as {
            queue?: ServerQueue;
            playback?: {
              type?: string;
              sentAt?: number;
              payload?: {
                playing?: boolean;
                trackId?: string | null;
                position?: number;
              };
            };
          };

          if (snapshot.queue) {
            applyServerQueue(snapshot.queue);
          }

          if (
            snapshot.playback?.payload
          ) {
            const playback =
              snapshot.playback.payload;

            if (playback.trackId) {
              const index =
                mediaQueueRef.current.findIndex(
                  (track) =>
                    track.id === playback.trackId
                );

              if (index !== -1) {
                const track =
                  mediaQueueRef.current[index];

                currentTrackIndexRef.current =
                  index;

                setCurrentTrackIndex(index);

                if (
                  track?.videoId &&
                  youtubePlayerRef.current
                ) {
                  youtubePlayerRef.current
                    .loadVideoById(track.videoId);
                }
              }
            }

            applyRemotePlayback(
              playback,
              snapshot.playback.sentAt
            );
          }
        }

        if (
          message.type === "queue.updated" &&
          message.payload
        ) {
          applyServerQueue(
            message.payload as ServerQueue
          );
        }

        if (
          message.type === "playback.state" &&
          message.payload
        ) {
          applyRemotePlayback(
            message.payload,
            message.sentAt
          );
        }

        if (
          message.type === "playback.track" &&
          message.payload?.trackId
        ) {
          const trackId = String(
            message.payload.trackId
          );

          const index = mediaQueueRef.current.findIndex(
            (track) => track.id === trackId
          );

          if (index !== -1) {
            const track = mediaQueueRef.current[index];

            currentTrackIndexRef.current = index;
            setCurrentTrackIndex(index);
            setMediaCurrentTime(0);

            if (
              track?.videoId &&
              youtubePlayerRef.current
            ) {
              youtubePlayerRef.current.loadVideoById(
                track.videoId
              );
            }

            setMediaPlaying(
              message.payload.playing !== false
            );
          }
        }
      } catch (error) {
        console.warn(
          "Invalid realtime queue event:",
          error
        );
      }
    };

    socket.onerror = (error) => {
      console.warn(
        "Realtime WebSocket error:",
        error
      );
    };

    return () => {
      if (realtimeSocketRef.current === socket) {
        realtimeSocketRef.current = null;
      }

      socket.close();
    };
  }, [roomId]);

  /*
   * Periodic playback sync heartbeat.
   * Keeps long-running rooms from slowly drifting apart.
   */
  useEffect(() => {
    if (!mediaPlaying || !currentTrack?.id) {
      return;
    }

    const interval = window.setInterval(() => {
      const player = youtubePlayerRef.current;

      if (!player) return;

      sendRealtimeEvent(
        "playback.state",
        {
          playing: true,
          trackId: currentTrack.id,
          position: player.getCurrentTime(),
        }
      );
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    mediaPlaying,
    currentTrack?.id,
    roomId,
  ]);

  const environmentProgress =
    duration > 0
      ? Math.min(1, Math.max(0, 1 - remaining / duration))
      : 0;

  const environmentStyle = {
    "--environment-progress": environmentProgress,
  } as React.CSSProperties;

  useEffect(() => {
    let cancelled = false;

    const createPlayer = () => {
      if (
        cancelled ||
        youtubePlayerRef.current ||
        !window.YT?.Player
      ) {
        return;
      }

      youtubePlayerRef.current = new window.YT.Player(
        "sky-youtube-player",
        {
          playerVars: {
            controls: 0,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },

          events: {
            onReady: () => {
              if (!cancelled) {
                setYoutubePlayerReady(true);
              }
            },

            onStateChange: (event) => {
              /* YouTube: 1 = playing, 2 = paused, 0 = ended */
              if (event.data === 1) {
                setMediaPlaying(true);
                setMediaVisualReady(true);
              }

              if (event.data === 2) {
                setMediaPlaying(false);
                setMediaVisualReady(false);
              }

              /* 0 = ended */
              if (event.data === 0) {
                setMediaVisualReady(false);

                const queue = mediaQueueRef.current;
                const index = currentTrackIndexRef.current;
                const repeat = repeatModeRef.current;
                const shuffle = shuffleEnabledRef.current;

                if (queue.length === 0) {
                  setMediaPlaying(false);
                  return;
                }

                /* Repeat current song */
                if (repeat === "one") {
                  const track = queue[index];

                  if (track?.videoId) {
                    setMediaCurrentTime(0);
                    setMediaPlaying(true);

                    window.setTimeout(() => {
                      youtubePlayerRef.current?.loadVideoById(
                        track.videoId!
                      );
                    }, 0);
                  }

                  return;
                }

                const atLastTrack =
                  index >= queue.length - 1;

                /*
                 * Repeat OFF stops after the final track when
                 * normal queue traversal is being used.
                 */
                if (
                  repeat === "off" &&
                  !shuffle &&
                  atLastTrack
                ) {
                  setMediaPlaying(false);
                  return;
                }

                let nextIndex: number;

                if (shuffle && queue.length > 1) {
                  const candidates = queue
                    .map((_, candidateIndex) => candidateIndex)
                    .filter(
                      (candidateIndex) =>
                        candidateIndex !== index
                    );

                  nextIndex =
                    candidates[
                      Math.floor(
                        Math.random() * candidates.length
                      )
                    ];
                } else {
                  nextIndex = atLastTrack
                    ? 0
                    : index + 1;
                }

                const nextTrack = queue[nextIndex];

                currentTrackIndexRef.current = nextIndex;
                setCurrentTrackIndex(nextIndex);
                setMediaCurrentTime(0);
                setMediaDuration(0);

                if (nextTrack?.videoId) {
                  setMediaPlaying(true);

                  window.setTimeout(() => {
                    youtubePlayerRef.current?.loadVideoById(
                      nextTrack.videoId!
                    );
                  }, 0);
                } else {
                  setMediaPlaying(false);
                }
              }

              /* 3 = buffering */
              if (event.data === 3) {
                setMediaVisualReady(false);
              }
            },
          },
        }
      );
    };

    if (window.YT?.Player) {
      createPlayer();
    } else {
      const previousReady = window.onYouTubeIframeAPIReady;

      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        createPlayer();
      };

      if (
        !document.querySelector(
          'script[src="https://www.youtube.com/iframe_api"]'
        )
      ) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;

        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;

      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, []);


  /*
   * Selected queue item changes:
   * cue its YouTube video into the sky player.
   */
  useEffect(() => {
    if (!youtubePlayerReady || !youtubePlayerRef.current) {
      return;
    }

    if (!currentTrack?.videoId) {
      youtubePlayerRef.current.pauseVideo();
      return;
    }

    setMediaVisualReady(false);
    setMediaCurrentTime(0);
    setMediaDuration(0);

    /*
     * loadVideoById changes the actual video and starts it.
     * mediaPlaying remains synchronized through onStateChange.
     */
    youtubePlayerRef.current.loadVideoById(currentTrack.videoId);
  }, [currentTrack?.videoId, youtubePlayerReady]);


  /*
   * Physical MP4 play/pause button drives YouTube.
   */
  useEffect(() => {
    if (!youtubePlayerReady || !youtubePlayerRef.current) {
      return;
    }

    if (!currentTrack?.videoId) {
      return;
    }

    if (mediaPlaying) {
      youtubePlayerRef.current.playVideo();
    } else {
      youtubePlayerRef.current.pauseVideo();
    }
  }, [
    mediaPlaying,
    currentTrack?.videoId,
    youtubePlayerReady,
  ]);


  useEffect(() => {
    if (
      !youtubePlayerReady ||
      !youtubePlayerRef.current ||
      !currentTrack?.videoId
    ) {
      setMediaCurrentTime(0);
      setMediaDuration(0);
      return;
    }

    const updatePlaybackClock = () => {
      const player = youtubePlayerRef.current;
      if (!player) return;

      try {
        const nextCurrentTime = player.getCurrentTime();
        const nextDuration = player.getDuration();

        if (Number.isFinite(nextCurrentTime)) {
          setMediaCurrentTime(nextCurrentTime);
        }

        if (Number.isFinite(nextDuration) && nextDuration > 0) {
          setMediaDuration(nextDuration);
        }
      } catch {
        /* iframe may still be initializing */
      }
    };

    updatePlaybackClock();

    const interval = window.setInterval(
      updatePlaybackClock,
      500
    );

    return () => window.clearInterval(interval);
  }, [
    youtubePlayerReady,
    currentTrack?.videoId,
  ]);


  useEffect(() => {
    const element = lcdTitleRef.current;

    if (!element) return;

    const MARQUEE_SPEED_PX_PER_SECOND = 14;

    const resetPosition = () => {
      /*
       * Start flush at the left edge — no indentation.
       */
      lcdTitlePositionRef.current = 0;
      lcdTitleLastTimeRef.current = null;

      element.style.transform = "translate3d(0px, 0, 0)";
    };

    resetPosition();

    const tick = (time: number) => {
      const el = lcdTitleRef.current;

      if (!el) return;

      if (lcdTitleLastTimeRef.current === null) {
        lcdTitleLastTimeRef.current = time;
      }

      const deltaSeconds =
        (time - lcdTitleLastTimeRef.current) / 1000;

      lcdTitleLastTimeRef.current = time;

      /*
       * Pause freezes the exact current pixel.
       */
      if (mediaPlaying) {
        lcdTitlePositionRef.current -=
          MARQUEE_SPEED_PX_PER_SECOND * deltaSeconds;

        const titleWidth = el.scrollWidth;
        const viewportWidth =
          el.parentElement?.clientWidth ?? 0;

        /*
         * Once the full title has exited left,
         * immediately restart just beyond the right edge.
         */
        if (
          lcdTitlePositionRef.current <=
          -titleWidth
        ) {
          lcdTitlePositionRef.current =
            viewportWidth;
        }

        el.style.transform =
          `translate3d(${lcdTitlePositionRef.current}px, 0, 0)`;
      }

      lcdTitleFrameRef.current =
        requestAnimationFrame(tick);
    };

    lcdTitleFrameRef.current =
      requestAnimationFrame(tick);

    return () => {
      if (lcdTitleFrameRef.current !== null) {
        cancelAnimationFrame(
          lcdTitleFrameRef.current
        );
      }
    };
  }, [mediaPlaying, currentTrack?.id]);


  useEffect(() => {
    const preloadImages = MODES.flatMap((item) => [
      item.scenery,
      item.stage,
      item.figure,
    ]).filter((src): src is string => Boolean(src));

    preloadImages.forEach((src) => {
      const image = new Image();
      image.src = src;
    });
  }, []);

  useEffect(() => {
    const query = discoveryQuery?.trim() || "";

    const cacheKey =
      `${mode.id}::${query.toLowerCase()}`;

    const cached =
      recommendationCacheRef.current.get(cacheKey);

    if (cached) {
      setRecommendations(cached);
      setRecommendationsLoading(false);
      setYoutubeQuotaExceeded(false);
      return;
    }

    const controller = new AbortController();

    const timeout = window.setTimeout(async () => {
      setRecommendationsLoading(true);
      setYoutubeQuotaExceeded(false);

      try {
        const params = new URLSearchParams({
          mode: mode.id,
        });

        if (query) {
          params.set("q", query);
        }

        const response = await fetch(
          `/api/recommendations?${params}`,
          {
            signal: controller.signal,
          }
        );

        const data = await response.json();

        if (!response.ok) {
          const message =
            typeof data?.message === "string"
              ? data.message
              : "";

          if (
            response.status === 502 &&
            message.toLowerCase().includes("quota")
          ) {
            setYoutubeQuotaExceeded(true);
            return;
          }

          throw new Error(
            data?.message ||
            `Recommendation request failed: ${response.status}`
          );
        }

        const nextRecommendations: YouTubeRecommendation[] =
          Array.isArray(data.results)
            ? data.results
            : [];

        recommendationCacheRef.current.set(
          cacheKey,
          nextRecommendations
        );

        setRecommendations(nextRecommendations);
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }

        console.error(
          "Could not load recommendations:",
          error
        );
      } finally {
        if (!controller.signal.aborted) {
          setRecommendationsLoading(false);
        }
      }
    }, 400);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [mode.id, discoveryQuery]);

  useEffect(() => {
    if (!running || remaining <= 0) return;

    const interval = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          setRunning(false);
          return 0;
        }

        return value - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [running, remaining]);

  const playTrackAtIndex = (
    index: number
  ) => {
    if (mediaQueue.length === 0) return;

    /*
     * Wrap around the queue so previous on the first track
     * goes to the last track and next on the last track goes
     * back to the first.
     */
    const normalizedIndex =
      ((index % mediaQueue.length) +
        mediaQueue.length) %
      mediaQueue.length;

    const track = mediaQueue[normalizedIndex];

    if (!track) return;

    setCurrentTrackIndex(normalizedIndex);

    sendRealtimeEvent(
      "playback.track",
      {
        trackId: track.id,
        playing: true,
        position: 0,
      }
    );

    setMediaCurrentTime(0);
    setMediaDuration(0);

    if (!track.videoId) {
      setMediaPlaying(false);
      return;
    }

    setMediaPlaying(true);

    if (
      youtubePlayerReady &&
      youtubePlayerRef.current
    ) {
      youtubePlayerRef.current.loadVideoById(
        track.videoId
      );
    }
  };

  const addRecommendationToQueue = async (
    recommendation: YouTubeRecommendation
  ) => {
    setDiscoveryQuery(
      `${recommendation.title} ${recommendation.artist}`
    );

    const existingIndex = mediaQueue.findIndex(
      (track) => track.videoId === recommendation.id
    );

    if (existingIndex !== -1) {
      playTrackAtIndex(existingIndex);
      return;
    }

    const newTrack: MediaTrack = {
      id: `youtube-${recommendation.id}`,
      title: recommendation.title,
      artist: recommendation.artist,
      videoId: recommendation.id,
    };

    /*
     * Optimistic local update keeps the player responsive.
     */
    const optimisticIndex = mediaQueue.length;
    setMediaQueue((queue) => [...queue, newTrack]);
    setCurrentTrackIndex(optimisticIndex);
    setMediaCurrentTime(0);
    setMediaDuration(0);
    setMediaPlaying(true);

    try {
      if (
        serverQueueReady &&
        serverQueueId &&
        serverQueueVersion !== null
      ) {
        const queue = await addTrackWithRetry(
          serverQueueId,
          serverQueueVersion,
          newTrack,
          roomId
        );

        applyServerQueue(queue);

        const index = queue.tracks.findIndex(
          (track) => track.id === newTrack.id
        );

        if (index !== -1) {
          setCurrentTrackIndex(index);
        }
      }

      if (
        youtubePlayerReady &&
        youtubePlayerRef.current &&
        newTrack.videoId
      ) {
        youtubePlayerRef.current.loadVideoById(
          newTrack.videoId
        );
      }
    } catch (error) {
      console.error("Could not persist queued track:", error);

      /*
       * Reconcile with server if our optimistic write lost
       * a version race.
       */
      if (serverQueueId) {
        try {
          const latest = await fetchServerQueue(serverQueueId);
          applyServerQueue(latest);
        } catch (refreshError) {
          console.error(
            "Could not reconcile server queue:",
            refreshError
          );
        }
      }
    }
  };

  const submitManualSearch = () => {
    const query = manualSearch.trim();

    if (!query) return;

    setDiscoveryQuery(query);
  };

  const resetDiscovery = () => {
    setDiscoveryQuery(null);
    setManualSearch("");
  };

  const seekFromPointer = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (
      mediaDuration <= 0 ||
      !youtubePlayerRef.current
    ) {
      return;
    }

    const rect =
      event.currentTarget.getBoundingClientRect();

    const ratio = Math.min(
      1,
      Math.max(
        0,
        (event.clientX - rect.left) / rect.width
      )
    );

    const nextTime = ratio * mediaDuration;

    sendRealtimeEvent(
      "playback.state",
      {
        playing: mediaPlaying,
        trackId: currentTrack?.id ?? null,
        position: nextTime,
      }
    );

    setMediaCurrentTime(nextTime);

    youtubePlayerRef.current.seekTo(
      nextTime,
      true
    );
  };

  const previousTrack = () => {
    if (mediaQueue.length === 0) return;

    if (shuffleEnabled) {
      const previousIndex =
        shuffleHistoryRef.current.pop();

      if (previousIndex !== undefined) {
        playTrackAtIndex(previousIndex);
      }

      return;
    }

    playTrackAtIndex(currentTrackIndex - 1);
  };

  const refillShuffleBag = (
    currentIndex: number
  ) => {
    const indices = mediaQueue
      .map((_, index) => index)
      .filter((index) => index !== currentIndex);

    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));

      [indices[i], indices[j]] = [
        indices[j],
        indices[i],
      ];
    }

    shuffleBagRef.current = indices;
  };

  const getNextShuffleIndex = (
    currentIndex: number
  ) => {
    if (mediaQueue.length <= 1) {
      return currentIndex;
    }

    if (shuffleBagRef.current.length === 0) {
      refillShuffleBag(currentIndex);
    }

    return (
      shuffleBagRef.current.shift() ??
      currentIndex
    );
  };

  const nextTrack = () => {
    if (mediaQueue.length === 0) return;

    if (shuffleEnabled) {
      const nextIndex =
        getNextShuffleIndex(currentTrackIndex);

      shuffleHistoryRef.current.push(
        currentTrackIndex
      );

      playTrackAtIndex(nextIndex);
      return;
    }

    playTrackAtIndex(currentTrackIndex + 1);
  };


  const selectTrack = (index: number) => {
    playTrackAtIndex(index);
  };

  const moveTrack = async (
    fromIndex: number,
    toIndex: number
  ) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= mediaQueue.length ||
      toIndex >= mediaQueue.length
    ) {
      return;
    }

    const activeTrackId = currentTrack?.id;

    const nextQueue = [...mediaQueue];
    const [movedTrack] = nextQueue.splice(fromIndex, 1);
    nextQueue.splice(toIndex, 0, movedTrack);

    setMediaQueue(nextQueue);

    if (activeTrackId) {
      const nextActiveIndex = nextQueue.findIndex(
        (track) => track.id === activeTrackId
      );

      if (nextActiveIndex !== -1) {
        setCurrentTrackIndex(nextActiveIndex);
      }
    }

    try {
      if (
        serverQueueReady &&
        serverQueueId &&
        serverQueueVersion !== null
      ) {
        const queue = await reorderQueueWithRetry(
          serverQueueId,
          serverQueueVersion,
          nextQueue.map((track) => track.id),
          roomId
        );

        applyServerQueue(queue);
      }
    } catch (error) {
      console.error("Could not persist queue reorder:", error);

      if (serverQueueId) {
        try {
          const latest = await fetchServerQueue(serverQueueId);
          applyServerQueue(latest);
        } catch (refreshError) {
          console.error(
            "Could not reconcile reordered queue:",
            refreshError
          );
        }
      }
    }
  };

  const removeTrack = async (
    index: number
  ) => {
    const trackToRemove = mediaQueue[index];

    if (!trackToRemove) return;

    const removingCurrent =
      trackToRemove.id === currentTrack?.id;

    const nextQueue = mediaQueue.filter(
      (_, queueIndex) => queueIndex !== index
    );

    setMediaQueue(nextQueue);

    if (nextQueue.length === 0) {
      setCurrentTrackIndex(0);
      setMediaPlaying(false);
      setMediaCurrentTime(0);
      setMediaDuration(0);

      youtubePlayerRef.current?.pauseVideo();
    } else if (removingCurrent) {
      const nextIndex = Math.min(
        index,
        nextQueue.length - 1
      );

      setCurrentTrackIndex(nextIndex);

      const nextTrack = nextQueue[nextIndex];

      if (nextTrack?.videoId) {
        setMediaPlaying(true);

        if (
          youtubePlayerReady &&
          youtubePlayerRef.current
        ) {
          youtubePlayerRef.current.loadVideoById(
            nextTrack.videoId
          );
        }
      } else {
        setMediaPlaying(false);
      }
    } else {
      const activeTrackId = currentTrack?.id;

      if (activeTrackId) {
        const nextIndex = nextQueue.findIndex(
          (track) => track.id === activeTrackId
        );

        if (nextIndex !== -1) {
          setCurrentTrackIndex(nextIndex);
        }
      }
    }

    try {
      if (
        serverQueueReady &&
        serverQueueId &&
        serverQueueVersion !== null
      ) {
        const queue = await removeTrackWithRetry(
          serverQueueId,
          serverQueueVersion,
          trackToRemove.id,
          roomId
        );

        applyServerQueue(queue);
      }
    } catch (error) {
      console.error("Could not persist queue removal:", error);

      if (serverQueueId) {
        try {
          const latest = await fetchServerQueue(serverQueueId);
          applyServerQueue(latest);
        } catch (refreshError) {
          console.error(
            "Could not reconcile removed track:",
            refreshError
          );
        }
      }
    }
  };

  const changeMode = (nextIndex: number) => {
    setModeIndex((nextIndex + MODES.length) % MODES.length);

    /*
     * New cultural mode starts from its own recommendation pool.
     */
    setDiscoveryQuery(null);
    setManualSearch("");
  };

  const previousMode = () => changeMode(modeIndex - 1);
  const nextMode = () => changeMode(modeIndex + 1);

  const startTimer = () => {
    if (running) {
      setRunning(false);
      return;
    }

    /* Resume an already-started session */
    if (duration > 0 && remaining > 0 && remaining < duration) {
      setRunning(true);
      return;
    }

    const hours = Math.max(0, Number(timerHours) || 0);
    const minutes = Math.max(0, Number(timerMinutes) || 0);
    const seconds = Math.max(0, Number(timerSeconds) || 0);

    const totalSeconds =
      Math.floor(hours) * 3600 +
      Math.floor(minutes) * 60 +
      Math.floor(seconds);

    /* Do nothing for 00:00:00 */
    if (totalSeconds <= 0) return;

    setDuration(totalSeconds);
    setRemaining(totalSeconds);

    setTimerHours(
      String(Math.floor(totalSeconds / 3600)).padStart(2, "0")
    );
    setTimerMinutes(
      String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0")
    );
    setTimerSeconds(
      String(totalSeconds % 60).padStart(2, "0")
    );

    setRunning(true);
  };

  const reset = () => {
    setRemaining(duration);
    setRunning(false);

    if (duration === 0) {
      setTimerHours("00");
      setTimerMinutes("00");
      setTimerSeconds("00");
    }
  };


  return (
    <main
      className={`app mode-${mode.id}`}
      style={environmentStyle}
    >
      <section className="memory-layer" aria-hidden="true">
        <div className="memory-video" />
        <div className="memory-grain" />

      </section>
<section className="mode-picker">
        <button
          className="mode-arrow"
          onClick={previousMode}
          aria-label="Previous mode"
        >
          ‹
        </button>

        <div className="mode-readout">
          <span className="mode-number">
            {mode.number} / {String(MODES.length).padStart(2, "0")}
          </span>

          <strong>{mode.label}</strong>

          <span className="mode-location">{mode.subtitle}</span>
        </div>

        <button
          className="mode-arrow"
          onClick={nextMode}
          aria-label="Next mode"
        >
          ›
        </button>
      </section>

      <nav className="mode-dots" aria-label="Traditional performance mode">
        {MODES.map((item, index) => (
          <button
            key={item.id}
            className={index === modeIndex ? "mode-dot active" : "mode-dot"}
            onClick={() => changeMode(index)}
          >
            <span>{item.number}</span>
            {item.shortLabel}
          </button>
        ))}
      </nav>

      <div
        className={`sky-media ${
          currentTrack?.videoId &&
          mediaVisualReady &&
          mediaPlaying
            ? "has-video"
            : ""
        }`}
        aria-hidden="true"
      >
        <div id="sky-youtube-player" />
      </div>

      <div className="day-night-light" aria-hidden="true">
        <div className="day-halo" />
      </div>

      {mode.scenery && (
        <div className="scenery-depth" aria-hidden="true">
          <img
            className="scenery-layer scenery-blurred"
            src={mode.scenery}
            alt=""
            draggable={false}
          />

          <img
            className="scenery-layer scenery-sharp"
            src={mode.scenery}
            alt=""
            draggable={false}
          />
        </div>
      )}



      <section className="keepsake"
        aria-live="polite"
      >
<img

          className="stage"
          src={mode.stage}
          alt={`${mode.label} stage`}
          draggable={false}
        />

        <div className="figure-wrap">
          <img
            className="figure"
            src={mode.figure}
            alt={`${mode.label} performer`}
            draggable={false}
          />
        </div>
      </section>

      <section className="timer-zone">
{!running ? (
          <div className="timer-edit-wrap">
            <div className="time-field">
              <input
                className="timer-part"
                type="number"
                min="0"
                value={timerHours}
                aria-label="Hours"
                onChange={(e) => setTimerHours(e.target.value)}
              />
              <span>HR</span>
            </div>

            <span className="timer-colon">:</span>

            <div className="time-field">
              <input
                className="timer-part"
                type="number"
                min="0"
                max="59"
                value={timerMinutes}
                aria-label="Minutes"
                onChange={(e) => setTimerMinutes(e.target.value)}
              />
              <span>MIN</span>
            </div>

            <span className="timer-colon">:</span>

            <div className="time-field">
              <input
                className="timer-part"
                type="number"
                min="0"
                max="59"
                value={timerSeconds}
                aria-label="Seconds"
                onChange={(e) => setTimerSeconds(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") startTimer();
                }}
              />
              <span>SEC</span>
            </div>
          </div>
        ) : (
          <button
            className="timer-running"
            onClick={() => setRunning(false)}
            aria-label="Pause timer"
          >
            <div className="time-field">
              <strong>{displayTime.hours}</strong>
              <span>HR</span>
            </div>

            <span className="timer-colon">:</span>

            <div className="time-field">
              <strong>{displayTime.minutes}</strong>
              <span>MIN</span>
            </div>

            <span className="timer-colon">:</span>

            <div className="time-field">
              <strong>{displayTime.seconds}</strong>
              <span>SEC</span>
            </div>
          </button>
        )}

        <div className="timer-actions">
          <button onClick={startTimer}>
            {running ? "PAUSE" : duration > 0 && remaining === 0 ? "AGAIN" : "START"}
          </button>

          <button onClick={reset}>RESET</button>
        </div>
      </section>

      <aside className={`pixel-player ${mediaPlaying ? "media-playing" : "media-paused"}`}>
        <img
          className="player-shell-art"
          src="/assets/player/saigon-player-original.png"
          alt=""
          aria-hidden="true"
          draggable={false}
        />

        {/* Invisible controls aligned over the PNG click wheel */}
        <div className="player-hit-controls">
          <button
            className="player-hit player-hit-menu"
            type="button"
            aria-label="Menu"
            onClick={() => setQueueOpen(false)}
          />

          <button
            className="player-hit player-hit-prev"
            type="button"
            aria-label="Previous track"
            onClick={previousTrack}
          />

          <button
            className="player-hit player-hit-play"
            type="button"
            aria-label={mediaPlaying ? "Pause" : "Play"}
            onClick={() => {
              setMediaPlaying((value) => {
                const nextPlaying = !value;

                sendRealtimeEvent(
                  "playback.state",
                  {
                    playing: nextPlaying,
                    trackId: currentTrack?.id ?? null,
                    position: mediaCurrentTime,
                  }
                );

                return nextPlaying;
              });
            }}
          />

          <button
            className="player-hit player-hit-next"
            type="button"
            aria-label="Next track"
            onClick={nextTrack}
          />

          <button
            className="player-hit player-hit-queue"
            type="button"
            aria-label={queueOpen ? "Close queue" : "Open queue"}
            onClick={() => setQueueOpen((open) => !open)}
          />
        </div>

        <div className="pixel-player-header">
          <span>NAM-MP3-EXE</span>
          <span>MP4</span>
        </div>

        <div className="pixel-player-screen">
          <div className="player-screen-top">
            <span>NOW PLAYING</span>
            <span>
              {String(currentTrackIndex + 1).padStart(2, "0")}/
              {String(mediaQueue.length).padStart(2, "0")}
            </span>
          </div>

          <div className="lcd-title-marquee">
            <span ref={lcdTitleRef}>
              {currentTrack?.title ?? "CHỌN BÀI"}
            </span>
          </div>
          <span>{currentTrack?.artist ?? "GỢI Ý TRỰC TUYẾN"}</span>

          <div
            className="player-progress"
            role="slider"
            aria-label="Track progress"
            aria-valuemin={0}
            aria-valuemax={Math.floor(mediaDuration)}
            aria-valuenow={Math.floor(mediaCurrentTime)}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(
                event.pointerId
              );

              seekFromPointer(event);
            }}
            onPointerMove={(event) => {
              if (
                event.currentTarget.hasPointerCapture(
                  event.pointerId
                )
              ) {
                seekFromPointer(event);
              }
            }}
          >
            {Array.from({ length: 10 }, (_, index) => {
              const progress =
                mediaDuration > 0
                  ? mediaCurrentTime / mediaDuration
                  : 0;

              return (
                <i
                  key={index}
                  className={
                    progress >= (index + 1) / 10
                      ? "active"
                      : ""
                  }
                />
              );
            })}
          </div>

          <div className="player-time">
            <span>{formatMediaTime(mediaCurrentTime)}</span>
            <span>{formatMediaTime(mediaDuration)}</span>
          </div>
        </div>

        <div className="click-wheel" aria-label="Media controls">
          <button className="wheel-top" type="button">MENU</button>
          <button
            className="wheel-left"
            type="button"
            aria-label="Previous"
            onClick={previousTrack}
          >
            ◀
          </button>
          <button
            className="wheel-center"
            type="button"
            aria-label={mediaPlaying ? "Pause" : "Play"}
            onClick={() => setMediaPlaying((value) => !value)}
          >
            {mediaPlaying ? "Ⅱ" : "▶"}
          </button>
          <button
            className="wheel-right"
            type="button"
            aria-label="Next"
            onClick={nextTrack}
          >
            ▶
          </button>
          <button
            className="wheel-bottom"
            type="button"
            onClick={() => setQueueOpen((open) => !open)}
          >
            QUEUE
          </button>
        </div>

        {queueOpen && (
          <div className="player-popover">
            <div className="player-popover-title">
              <span>QUEUE</span>

              <button
                className={
                  shuffleEnabled
                    ? "player-shuffle active"
                    : "player-shuffle"
                }
                type="button"
                onClick={() => {
                  shuffleBagRef.current = [];
                  shuffleHistoryRef.current = [];

                  setShuffleEnabled(
                    (value) => !value
                  );
                }}
                title="Shuffle"
              >
                ⇄
              </button>

              <button
                className="player-repeat"
                type="button"
                onClick={() =>
                  setRepeatMode((mode) =>
                    mode === "off"
                      ? "all"
                      : mode === "all"
                        ? "one"
                        : "off"
                  )
                }
                title="Repeat mode"
              >
                {repeatMode === "one"
                  ? "↻1"
                  : repeatMode === "all"
                    ? "↻"
                    : "→"}
              </button>

              <span>{String(mediaQueue.length).padStart(2, "0")}</span>
            </div>

            <div className="player-popover-list">
              <div className="player-popover-section-label">
                <span>QUEUE</span>
                <span>{String(mediaQueue.length).padStart(2, "0")}</span>
              </div>

              {mediaQueue.map((track, index) => (
                <div
                  key={track.id}
                  className={
                    index === currentTrackIndex
                      ? "player-popover-row active"
                      : "player-popover-row"
                  }
                  draggable
                  onDragStart={() => setDraggedTrackIndex(index)}
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();

                    if (draggedTrackIndex !== null) {
                      moveTrack(draggedTrackIndex, index);
                    }

                    setDraggedTrackIndex(null);
                  }}
                  onDragEnd={() => setDraggedTrackIndex(null)}
                >
                  <span
                    className="player-drag-handle"
                    aria-hidden="true"
                    title="Drag to reorder"
                  >
                    ⋮⋮
                  </span>

                  <button
                    type="button"
                    className="player-popover-track"
                    onClick={() => selectTrack(index)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>

                    <span className="player-popover-copy">
                      <strong>{track.title}</strong>
                      <small>{track.artist}</small>
                    </span>

                    <span className="player-track-state">
                      {index === currentTrackIndex && mediaPlaying
                        ? "▶"
                        : ""}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="player-remove-track"
                    aria-label={`Remove ${track.title} from queue`}
                    title="Remove from queue"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeTrack(index);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}

              <div className="player-popover-divider" />

              <form
                className="player-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitManualSearch();
                }}
              >
                <input
                  type="search"
                  value={manualSearch}
                  placeholder="TÌM BÀI HÁT..."
                  aria-label="Search YouTube music"
                  onChange={(event) =>
                    setManualSearch(event.target.value)
                  }
                />

                <button
                  type="submit"
                  aria-label="Search"
                  title="Search"
                >
                  →
                </button>
              </form>

              <div className="player-popover-section-label">
                <span>
                  {discoveryQuery
                    ? "KHÁM PHÁ"
                    : `GỢI Ý · ${mode.shortLabel}`}
                </span>

                {discoveryQuery ? (
                  <button
                    className="player-discovery-reset"
                    type="button"
                    onClick={resetDiscovery}
                    title="Return to recommendations"
                  >
                    ↺
                  </button>
                ) : (
                  <span>LIVE</span>
                )}
              </div>

              {youtubeQuotaExceeded ? (
                <div className="player-popover-loading quota-exhausted">
                  <strong>HẾT LƯỢT TÌM KIẾM HÔM NAY</strong>
                  <small>THỬ LẠI SAU · QUEUE VẪN HOẠT ĐỘNG</small>
                </div>
              ) : recommendationsLoading ? (
                <div className="player-popover-loading">
                  ĐANG TẢI...
                </div>
              ) : availableRecommendations.length === 0 ? (
                <div className="player-popover-loading">
                  KHÔNG CÓ GỢI Ý
                </div>
              ) : (
                availableRecommendations.map((recommendation) => {
                  return (
                    <button
                      key={recommendation.id}
                      type="button"
                      className="player-popover-rec"
                      onClick={() =>
                        addRecommendationToQueue(recommendation)
                      }
                    >
                      <span className="player-popover-rec-action">
                        +
                      </span>

                      <span className="player-popover-copy">
                        <strong>{recommendation.title}</strong>
                        <small>{recommendation.artist}</small>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

      </aside>

      <footer className="footer">
        <span>© 2001 SAIGON.EXE</span>
        <span>TRADITIONAL MEMORY SYSTEM</span>
      </footer>
    </main>
  );
}
