import { NextResponse } from 'next/server';

const NISAB_GRAMS = 85; // Nisab is 85 grams of gold

/**
 * Nisab API - Returns the nisab threshold (85 grams of gold value)
 * Calls the /api/gold endpoint internally to get the current gold price
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const debug = searchParams.get('debug') === '1';

  try {
    // Call the gold API internally
    const baseUrl = new URL(request.url).origin;
    const goldUrl = `${baseUrl}/api/gold?grams=true${debug ? '&debug=1' : ''}`;

    console.log('[Nisab API] Fetching gold price from:', goldUrl);
    const goldResponse = await fetch(goldUrl, { cache: 'no-store' });

    if (!goldResponse.ok) {
      console.error(
        '[Nisab API] Gold API returned error status:',
        goldResponse.status
      );
      return NextResponse.json(
        { error: 'Failed to fetch gold price' },
        { status: goldResponse.status }
      );
    }

    const goldData = await goldResponse.json();
    console.log('[Nisab API] Gold data received:', goldData);

    if (goldData.error) {
      return NextResponse.json({ error: goldData.error }, { status: 500 });
    }

    // Calculate nisab value
    const nisabValue = goldData.price_gram_24k * NISAB_GRAMS;

    return NextResponse.json({
      nisab: nisabValue,
      price_gram_24k: goldData.price_gram_24k,
      nisab_grams: NISAB_GRAMS,
      currency: goldData.currency,
      provider: goldData.provider,
      type: 'Gold',
      cached: goldData.cached || false,
    });
  } catch (error) {
    console.error('[Nisab API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to calculate nisab value' },
      { status: 500 }
    );
  }
}
