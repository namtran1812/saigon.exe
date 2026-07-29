package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	addr      = ":8080"
	cacheTTL  = 24 * time.Hour
	cacheFile = "cache/recommendations.json"
)

type Recommendation struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Artist    string `json:"artist"`
	Thumbnail string `json:"thumbnail"`
}

type cacheEntry struct {
	CreatedAt       time.Time        `json:"createdAt"`
	Recommendations []Recommendation `json:"recommendations"`
}

type persistentCache struct {
	mu      sync.RWMutex
	Entries map[string]cacheEntry `json:"entries"`
	path    string
}

type youtubeResponse struct {
	Items []struct {
		ID struct {
			VideoID string `json:"videoId"`
		} `json:"id"`

		Snippet struct {
			Title        string `json:"title"`
			ChannelTitle string `json:"channelTitle"`

			Thumbnails struct {
				Medium struct {
					URL string `json:"url"`
				} `json:"medium"`

				Default struct {
					URL string `json:"url"`
				} `json:"default"`
			} `json:"thumbnails"`
		} `json:"snippet"`
	} `json:"items"`

	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

var modeQueries = map[string]string{
	"quan-ho":       "quan họ Bắc Ninh dân ca biểu diễn",
	"nha-nhac":      "nhã nhạc cung đình Huế biểu diễn",
	"cai-luong":     "cải lương vọng cổ Việt Nam",
	"don-ca-tai-tu": "đờn ca tài tử Nam Bộ biểu diễn",
}

func newPersistentCache(path string) *persistentCache {
	c := &persistentCache{
		Entries: make(map[string]cacheEntry),
		path:    path,
	}

	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, c); err != nil {
			log.Printf("cache decode warning: %v", err)
			c.Entries = make(map[string]cacheEntry)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Printf("cache read warning: %v", err)
	}

	if c.Entries == nil {
		c.Entries = make(map[string]cacheEntry)
	}

	return c
}

func (c *persistentCache) get(key string) ([]Recommendation, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	entry, ok := c.Entries[key]
	if !ok {
		return nil, false
	}

	if time.Since(entry.CreatedAt) >= cacheTTL {
		return nil, false
	}

	return entry.Recommendations, true
}

func (c *persistentCache) set(key string, recommendations []Recommendation) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.Entries[key] = cacheEntry{
		CreatedAt:       time.Now().UTC(),
		Recommendations: recommendations,
	}

	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	tmp := c.path + ".tmp"

	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}

	return os.Rename(tmp, c.path)
}

func cacheKey(query string) string {
	return strings.ToLower(strings.TrimSpace(query))
}

func searchYouTube(apiKey, query string) ([]Recommendation, error) {
	params := url.Values{}

	params.Set("part", "snippet")
	params.Set("type", "video")
	params.Set("videoEmbeddable", "true")
	params.Set("videoSyndicated", "true")
	params.Set("relevanceLanguage", "vi")
	params.Set("regionCode", "VN")
	params.Set("maxResults", "8")
	params.Set("q", query)
	params.Set("key", apiKey)

	endpoint :=
		"https://www.googleapis.com/youtube/v3/search?" +
			params.Encode()

	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var payload youtubeResponse

	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		if payload.Error != nil {
			return nil, fmt.Errorf(
				"youtube status %d: %s",
				payload.Error.Code,
				payload.Error.Message,
			)
		}

		return nil, fmt.Errorf(
			"youtube status %d",
			resp.StatusCode,
		)
	}

	results := make([]Recommendation, 0, len(payload.Items))

	for _, item := range payload.Items {
		if item.ID.VideoID == "" || item.Snippet.Title == "" {
			continue
		}

		thumbnail := item.Snippet.Thumbnails.Medium.URL
		if thumbnail == "" {
			thumbnail = item.Snippet.Thumbnails.Default.URL
		}

		results = append(results, Recommendation{
			ID:        item.ID.VideoID,
			Title:     item.Snippet.Title,
			Artist:    item.Snippet.ChannelTitle,
			Thumbnail: thumbnail,
		})
	}

	return results, nil
}

func main() {
	apiKey := strings.TrimSpace(os.Getenv("YOUTUBE_API_KEY"))

	if apiKey == "" {
		log.Fatal("YOUTUBE_API_KEY is required")
	}

	cache := newPersistentCache(cacheFile)

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	})

	mux.HandleFunc("/api/recommendations", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		mode := strings.TrimSpace(r.URL.Query().Get("mode"))
		query := strings.TrimSpace(r.URL.Query().Get("q"))

		if query == "" {
			query = modeQueries[mode]
		}

		if query == "" {
			http.Error(w, "missing valid mode or q", http.StatusBadRequest)
			return
		}

		key := cacheKey(query)

		if cached, ok := cache.get(key); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Saigon-Cache", "HIT")

			json.NewEncoder(w).Encode(map[string]any{
				"query":   query,
				"source":  "cache",
				"results": cached,
			})
			return
		}

		results, err := searchYouTube(apiKey, query)
		if err != nil {
			log.Printf("youtube search failed: %v", err)

			w.Header().Set("Content-Type", "application/json")

			w.WriteHeader(http.StatusBadGateway)

			json.NewEncoder(w).Encode(map[string]any{
				"error":   "youtube_search_failed",
				"message": err.Error(),
			})

			return
		}

		if err := cache.set(key, results); err != nil {
			log.Printf("cache write warning: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Saigon-Cache", "MISS")

		json.NewEncoder(w).Encode(map[string]any{
			"query":   query,
			"source":  "youtube",
			"results": results,
		})
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("saigon.exe API listening on http://localhost%s", addr)

	log.Fatal(server.ListenAndServe())
}
