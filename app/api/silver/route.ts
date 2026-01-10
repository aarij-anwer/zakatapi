/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const GOLD_API_KEYS = [
  process.env.GOLD_API_KEY_1,
  process.env.GOLD_API_KEY_2,
  process.env.GOLD_API_KEY_3,
];
const METALS_API_KEY = process.env.METALS_API_KEY;
const FCS_API_KEY = process.env.FCS_API_KEY;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache for silver prices

type SilverPricePayload = {
  price_oz: number;
  price_gram_24k: number;
  currency: string;
  provider: string;
  cached?: boolean;
};

const priceCache = new Map<string, { ts: number; data: SilverPricePayload }>();

function getCachedPrice(key: string): SilverPricePayload | null {
  const cached = priceCache.get(key);
  if (!cached) {
    console.log(`[Silver Cache MISS] ${key}`);
    return null;
  }
  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    priceCache.delete(key);
    console.log(`[Silver Cache EXPIRED] ${key}`);
    return null;
  }
  console.log(
    `[Silver Cache HIT] ${key} (age: ${Math.round(
      (Date.now() - cached.ts) / 1000
    )}s)`
  );
  return { ...cached.data, cached: true };
}

function setCachedPrice(key: string, data: SilverPricePayload) {
  priceCache.set(key, { ts: Date.now(), data });
}

function updateMonthlyPriceFile(data: SilverPricePayload) {
  // Non-blocking update - don't fail the API request if this fails
  try {
    const filePath = join(
      process.cwd(),
      'public',
      'silver-monthly-prices.json'
    );
    let monthlyPrices: Record<string, any> = {};

    // Load existing data
    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      monthlyPrices = JSON.parse(fileContent);
    } catch {
      // File doesn't exist or is invalid - start fresh
      console.log('[Update Silver Monthly File] Creating new file');
    }

    // Get current month key (YYYY-MM format)
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, '0')}`;

    // Update current month with latest successful price
    monthlyPrices[monthKey] = {
      price: data.price_oz,
      price_oz: data.price_oz,
      price_gram_24k: data.price_gram_24k,
      currency: data.currency,
      provider: data.provider,
      cached: true,
      timestamp: now.toISOString(),
    };

    // Write back to file
    writeFileSync(filePath, JSON.stringify(monthlyPrices, null, 2), 'utf-8');

    console.log(
      `[Update Silver Monthly File] Updated ${monthKey} with ${data.price_oz} CAD/oz from ${data.provider}`
    );
  } catch (error) {
    // Don't fail the request if file update fails
    console.error('[Update Silver Monthly File] Error updating file:', error);
  }
}

function getMonthlyFallback(): SilverPricePayload | null {
  try {
    const filePath = join(
      process.cwd(),
      'public',
      'silver-monthly-prices.json'
    );
    const fileContent = readFileSync(filePath, 'utf-8');
    const monthlyPrices = JSON.parse(fileContent);

    // Get current month key (YYYY-MM format)
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, '0')}`;

    // Try current month first
    if (monthlyPrices[currentMonth]) {
      console.log(
        `[Silver Monthly Fallback] Using current month: ${currentMonth}`
      );
      return {
        ...monthlyPrices[currentMonth],
        provider: 'monthly-fallback',
      };
    }

    // Fall back to most recent month
    const months = Object.keys(monthlyPrices).sort().reverse();
    if (months.length > 0) {
      const latestMonth = months[0];
      console.log(
        `[Silver Monthly Fallback] Using latest available: ${latestMonth}`
      );
      return {
        ...monthlyPrices[latestMonth],
        provider: 'monthly-fallback',
      };
    }

    return null;
  } catch (error) {
    console.error(
      '[Silver Monthly Fallback] Error reading monthly prices:',
      error
    );
    return null;
  }
}

async function fetchGoldApiIo(): Promise<SilverPricePayload | null> {
  for (let i = 0; i < GOLD_API_KEYS.length; i++) {
    const key = GOLD_API_KEYS[i];
    if (!key) continue;

    const keyName = `GOLD_API_KEY_${i + 1}`;

    try {
      const response = await fetch('https://www.goldapi.io/api/XAG/CAD', {
        headers: {
          'x-access-token': key,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      });

      if (response.ok) {
        const data = await response.json();
        if (
          typeof data.price === 'number' &&
          typeof data.price_gram_24k === 'number'
        ) {
          console.log(`[goldapi.io/silver] Success using ${keyName}`);
          return {
            price_oz: data.price,
            price_gram_24k: data.price_gram_24k,
            currency: 'CAD',
            provider: `goldapi.io (${keyName})`,
          };
        }
      } else {
        console.log(
          `[goldapi.io/silver] ${keyName} failed with status ${response.status}`
        );
      }
    } catch (error) {
      console.error(`[goldapi.io/silver] ${keyName} error:`, error);
    }
  }
  return null;
}

async function fetchMetalsApi(): Promise<SilverPricePayload | null> {
  if (!METALS_API_KEY) {
    console.log('[metals-api/silver] Skipping - no API key configured');
    return null;
  }

  try {
    const response = await fetch(
      `https://metals-api.com/api/latest?access_key=${METALS_API_KEY}&base=XAG&symbols=CAD`,
      { cache: 'no-store' }
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (data?.success && data?.rates?.CAD) {
      // metals-api returns rate as XAG/CAD (how much CAD for 1 oz silver)
      const price_oz = 1 / data.rates.CAD;
      const price_gram_24k = price_oz / 31.1034768; // troy oz to grams

      return {
        price_oz,
        price_gram_24k,
        currency: 'CAD',
        provider: 'metals-api',
      };
    }
    return null;
  } catch (error) {
    console.error('[metals-api/silver] Error:', error);
    return null;
  }
}

async function fetchFcsApi(): Promise<SilverPricePayload | null> {
  if (!FCS_API_KEY) {
    console.log('[fcsapi/silver] Skipping - no API key configured');
    return null;
  }

  try {
    const response = await fetch(
      `https://fcsapi.com/api-v3/forex/latest?symbol=XAG/CAD&access_key=${FCS_API_KEY}`,
      { cache: 'no-store' }
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (data?.status && data?.response?.[0]?.price) {
      const price_oz = Number(data.response[0].price);
      const price_gram_24k = price_oz / 31.1034768;

      return {
        price_oz,
        price_gram_24k,
        currency: 'CAD',
        provider: 'fcsapi',
      };
    }
    return null;
  } catch (error) {
    console.error('[fcsapi/silver] Error:', error);
    return null;
  }
}

/**
 * Silver Price API - Waterfall provider strategy:
 * 1. goldapi.io (primary, tries 3 API keys)
 * 2. metals-api.com (alternative provider)
 * 3. fcsapi.com (backup provider)
 * 4. monthly-fallback (stored JSON data from beginning of month)
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const grams = searchParams.get('grams') === 'true';
  const debug = searchParams.get('debug') === '1';
  const errors: Array<{ provider: string; message: string }> = [];

  // Check cache first (skip if debug mode)
  const cacheKey = 'XAG-CAD';
  const cached = debug ? null : getCachedPrice(cacheKey);
  if (cached) {
    const price = grams ? cached.price_gram_24k : cached.price_oz;
    return NextResponse.json({ price, ...cached });
  }

  // Try providers in order
  const providers = [
    { name: 'goldapi.io', fn: fetchGoldApiIo },
    { name: 'metals-api', fn: fetchMetalsApi },
    { name: 'fcsapi', fn: fetchFcsApi },
  ];

  for (const { name, fn } of providers) {
    try {
      const result = await fn();
      if (result) {
        // Cache the result
        if (!debug) setCachedPrice(cacheKey, result);

        // Update monthly price file with latest successful price
        updateMonthlyPriceFile(result);

        const price = grams ? result.price_gram_24k : result.price_oz;
        return NextResponse.json({
          price,
          price_oz: result.price_oz,
          price_gram_24k: result.price_gram_24k,
          currency: result.currency,
          provider: result.provider,
          cached: false,
        });
      }

      if (debug) {
        errors.push({
          provider: name,
          message: 'No data in response',
        });
      }
    } catch (error) {
      if (debug) {
        errors.push({
          provider: name,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  // All providers failed - try monthly fallback
  const fallback = getMonthlyFallback();
  if (fallback) {
    const price = grams ? fallback.price_gram_24k : fallback.price_oz;
    return NextResponse.json({
      price,
      price_oz: fallback.price_oz,
      price_gram_24k: fallback.price_gram_24k,
      currency: fallback.currency,
      provider: fallback.provider,
      cached: false,
    });
  }

  // Complete failure
  console.error('[Silver API] All providers failed');
  return NextResponse.json(
    {
      error: 'Failed to fetch silver price from all providers',
      ...(debug ? { debug: errors } : {}),
    },
    { status: 500 }
  );
}
