// High-performance in-memory TTL Caching Module for Book Vardi Backend

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttlSeconds = 60) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000
    });
  }

  clear(pattern = null) {
    if (!pattern) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) {
        this.store.delete(key);
      }
    }
    // Also clear general product catalog keys
    this.store.clear();
  }
}

export const apiCache = new MemoryCache();

// Express Cache Middleware for Public GET Endpoints
export const cacheMiddleware = (ttlSeconds = 60) => {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== "GET") return next();

    // Skip caching if authenticated or query parameter bypasses cache
    if (req.query?.bypassCache === "true" || req.query?.includePending === "true" || req.headers.authorization) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return next();
    }

    const cacheKey = req.originalUrl || req.url;
    const cachedData = apiCache.get(cacheKey);

    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Cache-Control", "no-cache, private, must-revalidate");
      return res.json(cachedData);
    }

    // Wrap res.json to store successful GET responses in RAM cache
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && body) {
        apiCache.set(cacheKey, body, ttlSeconds);
      }
      res.setHeader("X-Cache", "MISS");
      res.setHeader("Cache-Control", "no-cache, private, must-revalidate");
      return originalJson(body);
    };

    next();
  };
};

export const clearCache = (pattern) => apiCache.clear(pattern);
