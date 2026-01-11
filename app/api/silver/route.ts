/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
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
    // Fetch silver price in USD
    const silverUrl = `https://api-v4.fcsapi.com/forex/latest?symbol=XAGUSD&type=commodity&access_key=${FCS_API_KEY}`;
    console.log(
      '[fcsapi/silver] Fetching silver from:',
      silverUrl.replace(FCS_API_KEY, '***')
    );

    const silverResponse = await fetch(silverUrl, { cache: 'no-store' });
    if (!silverResponse.ok) {
      const errorText = await silverResponse.text();
      console.log('[fcsapi/silver] Silver error response:', errorText);
      return null;
    }

    const silverData = await silverResponse.json();
    console.log(
      '[fcsapi/silver] Silver response:',
      JSON.stringify(silverData, null, 2)
    );

    // Find FCM:XAGUSD ticker
    const silverTicker = silverData?.response?.find(
      (r: any) => r.ticker === 'FCM:XAGUSD'
    );
    if (!silverTicker?.active?.c) {
      console.log('[fcsapi/silver] FCM:XAGUSD ticker not found');
      return null;
    }

    const price_oz_usd = Number(silverTicker.active.c);
    console.log('[fcsapi/silver] Silver price in USD per oz:', price_oz_usd);

    // Fetch USD/CAD exchange rate from custom endpoint
    const forexUrl = `https://smart-portfolio-allocator.vercel.app/api/fx?base=USD&quote=CAD`;
    console.log('[fcsapi/silver] Fetching USD/CAD from custom endpoint');
    const forexResponse = await fetch(forexUrl, { cache: 'no-store' });
    if (!forexResponse.ok) {
      console.log('[fcsapi/silver] Failed to fetch USD/CAD rate');
      return null;
    }

    const forexData = await forexResponse.json();
    console.log(
      '[fcsapi/silver] Forex response:',
      JSON.stringify(forexData, null, 2)
    );
    const usdCadRate = forexData?.rate ? Number(forexData.rate) : 1.4; // Fallback rate
    console.log('[fcsapi/silver] USD/CAD rate:', usdCadRate);

    // Convert to CAD
    const price_oz = price_oz_usd * usdCadRate;
    const price_gram_24k = price_oz / 31.1034768;

    console.log(
      '[fcsapi/silver] Success! Price per oz (CAD):',
      price_oz,
      'Price per gram:',
      price_gram_24k
    );
    return {
      price_oz,
      price_gram_24k,
      currency: 'CAD',
      provider: 'fcsapi',
    };
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
    console.log(`[Silver API] Trying provider: ${name}`);
    try {
      const result = await fn();
      if (result) {
        console.log(`[Silver API] ✓ Success with ${name}`);
        // Cache the result
        if (!debug) setCachedPrice(cacheKey, result);

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

      console.log(`[Silver API] ✗ ${name} returned no data`);
      if (debug) {
        errors.push({
          provider: name,
          message: 'No data in response',
        });
      }
    } catch (error) {
      console.log(`[Silver API] ✗ ${name} threw error:`, error);
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
