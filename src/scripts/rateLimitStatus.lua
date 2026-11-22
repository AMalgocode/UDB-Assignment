-- rateLimitStatus.lua
-- Inspect rate limit status for a client without consuming capacity
--
-- KEYS[1] = Rate limit key (e.g. "rate-limit:192.168.1.1")
-- ARGV[1] = Current Unix timestamp in milliseconds (now)
-- ARGV[2] = Sliding window size in milliseconds (window_ms)
-- ARGV[3] = Maximum allowed requests in window (max_requests)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])

local window_start = now - window_ms

-- Remove expired records older than window boundary
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count active requests within the window
local current_count = redis.call('ZCARD', key)

local remaining = max_requests - current_count
if remaining < 0 then
    remaining = 0
end

local reset_in_sec = 0
if current_count > 0 then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if #oldest > 0 then
        local oldest_score = tonumber(oldest[2])
        local reset_ms = (oldest_score + window_ms) - now
        if reset_ms < 0 then
            reset_ms = 0
        end
        reset_in_sec = math.ceil(reset_ms / 1000)
    end
end

-- Return array: [current_count, remaining, reset_in_sec]
return { current_count, remaining, reset_in_sec }
