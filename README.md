# Zakat API

A resilient Next.js API for fetching real-time gold and silver prices in CAD with multiple provider fallback strategies.

## Features

- **Multi-provider waterfall strategy** - Automatic failover across multiple data sources
- **In-memory caching** - 10-minute cache to reduce API calls
- **Monthly fallback** - Auto-updated JSON storage for guaranteed uptime
- **Debug mode** - Detailed error reporting for troubleshooting
- **Public price history** - Accessible monthly price snapshots

## API Endpoints

### Gold Price API

#### Get Current Gold Price

```
GET /api/gold
GET /api/gold?grams=true
GET /api/gold?debug=1
```

**Query Parameters:**

- `grams=true` - Returns price per gram (24k) instead of per troy ounce
- `debug=1` - Returns detailed error information from all providers

**Response:**

```json
{
  "price": 6274.64,
  "price_oz": 6274.64,
  "price_gram_24k": 201.7344,
  "currency": "CAD",
  "provider": "goldapi.io (GOLD_API_KEY_1)",
  "cached": false
}
```

#### Update Monthly Snapshot (Protected)

```
POST /api/gold/update-monthly?secret=YOUR_SECRET
```

#### Monthly Price History (Public)

```
GET /gold-monthly-prices.json
```

### Silver Price API

#### Get Current Silver Price

```
GET /api/silver
GET /api/silver?grams=true
GET /api/silver?debug=1
```

**Query Parameters:**

- `grams=true` - Returns price per gram instead of per troy ounce
- `debug=1` - Returns detailed error information from all providers

**Response:**

```json
{
  "price": 111.226,
  "price_oz": 111.226,
  "price_gram_24k": 3.576,
  "currency": "CAD",
  "provider": "goldapi.io (GOLD_API_KEY_1)",
  "cached": false
}
```

#### Update Monthly Snapshot (Protected)

```
POST /api/silver/update-monthly?secret=YOUR_SECRET
```

#### Monthly Price History (Public)

```
GET /silver-monthly-prices.json
```

### Nisab API

#### Get Current Nisab Value in Gold

```
GET /api/nisab
GET /api/nisab?debug=1
```

**Query Parameters:**

- `debug=1` - Returns detailed error information from all providers

**Response:**

```json
{
  "nisab": 17147.42,
  "price_gram_24k": 201.7344,
  "nisab_grams": 85,
  "currency": "CAD",
  "provider": "goldapi.io (GOLD_API_KEY_1)",
  "type": "Gold",
  "cached": false
}
```

The nisab endpoint calculates the Islamic nisab threshold, which is 85 grams of gold. It internally calls the `/api/gold?grams=true` endpoint and multiplies the result by 85, ensuring consistency with the gold price API.

## Waterfall Provider Strategy

Both gold and silver APIs use a resilient waterfall approach that tries providers sequentially until one succeeds:

### 0. In-Memory Cache (First Priority)

- Checks 10-minute in-memory cache
- If found → return immediately
- Skipped in debug mode

### 1. goldapi.io (Primary)

- Tries 3 API keys sequentially: `GOLD_API_KEY_1`, `GOLD_API_KEY_2`, `GOLD_API_KEY_3`
- Logs which key was used
- If any succeeds → cache, update monthly file, and return
- If all fail → move to next provider

### 2. metals-api.com (Secondary)

- Requires `METALS_API_KEY` environment variable
- Skipped if no key configured
- If succeeds → cache, update monthly file, and return
- If fails → move to next provider

### 3. fcsapi.com (Tertiary)

- Requires `FCS_API_KEY` environment variable
- Fetches XAUUSD commodity price from FCS API v4
- Converts USD price to CAD using custom forex endpoint
- Falls back to 1.40 USD/CAD rate if conversion fails
- Skipped if no key configured
- If succeeds → cache, update monthly file, and return
- If fails → move to next provider

### 4. Monthly Fallback (Last Resort)

- Reads from `/public/{metal}-monthly-prices.json`
- Uses current month's stored price (auto-updated on every successful API call)
- If current month not found, uses most recent available month
- Guarantees API never fully fails

### Key Benefits

- **Resilience**: Single provider failure doesn't break the API
- **Cost optimization**: Uses free/cheaper providers as fallbacks
- **Rate limit tolerance**: Automatically rotates through API keys and providers
- **Guaranteed uptime**: Monthly fallback ensures service availability
- **Auto-maintenance**: JSON files update automatically on every successful call

## Environment Variables

Create a `.env.local` file with the following:

```env
# Gold API Keys (goldapi.io) - tries in order
GOLD_API_KEY_1=your-key-1
GOLD_API_KEY_2=your-key-2
GOLD_API_KEY_3=your-key-3

# Optional fallback providers
METALS_API_KEY=your-metals-api-key
FCS_API_KEY=your-fcs-api-key

# Protected endpoint secret for monthly updates
UPDATE_MONTHLY_SECRET=your-random-secret
```
