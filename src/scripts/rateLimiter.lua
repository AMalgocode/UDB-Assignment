-- rateLimiter.lua
-- Atomic Sliding Window Log Rate Limiter using Redis Sorted Sets
--
-- KEYS[1] = Rate limit key (e.g. "rate-limit:192.168.1.1")
-- ARGV[1] = Current Unix timestamp in milliseconds (now)
-- ARGV[2] = Sliding window size in milliseconds (window_ms)
-- ARGV[3] = Maximum allowed requests in window (max_requests)
-- ARGV[4] = Unique member identifier for this request (member_id)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member_id = ARGV[4]

local window_start = now - window_ms

-- Step 1: Remove all requests older than the sliding window boundary
-- Any score <= window_start has expired
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Step 2: Count the number of active requests in the current window
local current_count = redis.call('ZCARD', key)

local allowed = 0
local remaining = 0
local retry_after_sec = 0
local reset_in_sec = 0

if current_count < max_requests then
    -- Step 3: Allow request
    -- Add the new request timestamp to the Sorted Set
    redis.call('ZADD', key, now, member_id)

    -- Step 4: Set automatic key expiration equal to the window duration
    -- Inactive client keys will automatically be purged from Redis memory
    redis.call('PEXPIRE', key, window_ms)

    allowed = 1
    current_count = current_count + 1
    remaining = max_requests - current_count

    -- Calculate reset time based on the oldest request in the current window
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if #oldest > 0 then
        local oldest_score = tonumber(oldest[2])
        local reset_ms = (oldest_score + window_ms) - now
        if reset_ms < 0 then
            reset_ms = 0
        end
        reset_in_sec = math.ceil(reset_ms / 1000)
    else
        reset_in_sec = math.ceil(window_ms / 1000)
    end
else
    -- Step 5: Reject request (rate limit exceeded)
    allowed = 0
    remaining = 0

    -- Refresh key expiration so active rate-limited keys do not vanish prematurely
    redis.call('PEXPIRE', key, window_ms)

    -- Calculate retry-after: time until the oldest request slides out of the window
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if #oldest > 0 then
        local oldest_score = tonumber(oldest[2])
        local retry_ms = (oldest_score + window_ms) - now
        if retry_ms <= 0 then
            retry_ms = 1000
        end
        retry_after_sec = math.ceil(retry_ms / 1000)
        reset_in_sec = retry_after_sec
    else
        retry_after_sec = math.ceil(window_ms / 1000)
        reset_in_sec = retry_after_sec
    end
end

-- Return array: [allowed (0/1), remaining, current_count, retry_after_sec, reset_in_sec]
return { allowed, remaining, current_count, retry_after_sec, reset_in_sec }
