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

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache
const NISAB_GRAMS = 85; // Nisab is 85 grams of gold

type GoldPricePayload = {
  price_oz: number;
  price_gram_24k: number;
  currency: string;
  provider: string;
  type: 'Gold' | 'Silver';
  cached?: boolean;
};

const priceCache = new Map<string, { ts: number; data: GoldPricePayload }>();

function getCachedPrice(key: string): GoldPricePayload | null {
  const cached = priceCache.get(key);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.ts > CACHE_TTL_MS) {
    priceCache.delete(key);
    return null;
  }
  return { ...cached.data, cached: true };
}

function setCachedPrice(key: string, data: GoldPricePayload) {
  priceCache.set(key, { ts: Date.now(), data });
}

function getMonthlyFallback(): GoldPricePayload | null {
  try {
    const filePath = join(process.cwd(), 'public', 'gold-monthly-prices.json');
    const fileContent = readFileSync(filePath, 'utf-8');
    const monthlyPrices = JSON.parse(fileContent);

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, '0')}`;

    if (monthlyPrices[currentMonth]) {
      return {
        ...monthlyPrices[currentMonth],
        provider: 'monthly-fallback',
      };
    }

    const months = Object.keys(monthlyPrices).sort().reverse();
    if (months.length > 0) {
      const latestMonth = months[0];
      return {
        ...monthlyPrices[latestMonth],
        provider: 'monthly-fallback',
      };
    }

    return null;
  } catch (error) {
    console.error('[Nisab Monthly Fallback] Error:', error);
    return null;
  }
}

async function fetchGoldApiIo(): Promise<GoldPricePayload | null> {
  for (let i = 0; i < GOLD_API_KEYS.length; i++) {
    const key = GOLD_API_KEYS[i];
    if (!key) continue;

    const keyName = `GOLD_API_KEY_${i + 1}`;

    try {
      const response = await fetch('https://www.goldapi.io/api/XAU/CAD', {
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
          return {
            price_oz: data.price,
            price_gram_24k: data.price_gram_24k,
            currency: 'CAD',
            provider: `goldapi.io (${keyName})`,
            type: 'Gold',
          };
        }
      }
    } catch (error) {
      console.error(`[goldapi.io] Error:`, error);
    }
  }
  return null;
}

async function fetchMetalsApi(): Promise<GoldPricePayload | null> {
  if (!METALS_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(
      `https://metals-api.com/api/latest?access_key=${METALS_API_KEY}&base=XAU&symbols=CAD`,
      { cache: 'no-store' }
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (data?.success && data?.rates?.CAD) {
      const price_oz = 1 / data.rates.CAD;
      const price_gram_24k = price_oz / 31.1034768;

      return {
        price_oz,
        price_gram_24k,
        currency: 'CAD',
        provider: 'metals-api',
        type: 'Gold',
      };
    }
    return null;
  } catch (error) {
    console.error('[metals-api] Error:', error);
    return null;
  }
}

async function fetchFcsApi(): Promise<GoldPricePayload | null> {
  if (!FCS_API_KEY) {
    return null;
  }

  try {
    const response = await fetch(
      `https://fcsapi.com/api-v3/forex/latest?symbol=XAU/CAD&access_key=${FCS_API_KEY}`,
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
        type: 'Gold',
      };
    }
    return null;
  } catch (error) {
    console.error('[fcsapi] Error:', error);
    return null;
  }
}

/**
 * Nisab API - Returns the nisab threshold (85 grams of gold value)
 * Uses the same provider waterfall strategy as the gold API
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get('debug') === '1';

  // Check cache first
  const cacheKey = 'XAU-CAD';
  const cached = debug ? null : getCachedPrice(cacheKey);
  if (cached) {
    const nisabValue = cached.price_gram_24k * NISAB_GRAMS;
    return NextResponse.json({
      nisab: nisabValue,
      price_gram_24k: cached.price_gram_24k,
      nisab_grams: NISAB_GRAMS,
      currency: cached.currency,
      provider: cached.provider,
      type: cached.type,
      cached: true,
    });
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

        const nisabValue = result.price_gram_24k * NISAB_GRAMS;
        return NextResponse.json({
          nisab: nisabValue,
          price_gram_24k: result.price_gram_24k,
          nisab_grams: NISAB_GRAMS,
          currency: result.currency,
          provider: result.provider,
          type: result.type,
          cached: false,
        });
      }
    } catch (error) {
      console.error(`[Nisab API] ${name} error:`, error);
    }
  }

  // All providers failed - try monthly fallback
  const fallback = getMonthlyFallback();
  if (fallback) {
    const nisabValue = fallback.price_gram_24k * NISAB_GRAMS;
    return NextResponse.json({
      nisab: nisabValue,
      price_gram_24k: fallback.price_gram_24k,
      nisab_grams: NISAB_GRAMS,
      currency: fallback.currency,
      provider: fallback.provider,
      type: fallback.type,
      cached: false,
    });
  }

  // Complete failure
  console.error('[Nisab API] All providers failed');
  return NextResponse.json(
    {
      error: 'Failed to fetch nisab value from all providers',
    },
    { status: 500 }
  );
}
