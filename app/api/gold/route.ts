import { NextResponse } from 'next/server';

const API_KEYS = [
  process.env.GOLD_API_KEY_1,
  process.env.GOLD_API_KEY_2, 
  process.env.GOLD_API_KEY_3, 
];

export async function GET(request: Request): Promise<Response> {
  // Parse the query parameter
  const { searchParams } = new URL(request.url);
  const grams = searchParams.get('grams') === 'true';

  let data: any = null;
  let success = false;
  let lastError: Error | null = null;

  // Iterate over available API keys
  for (const key of API_KEYS) {
    if (!key) continue; // skip if key is not defined

    try {
      const response = await fetch("https://www.goldapi.io/api/XAU/CAD", {
        headers: {
          "x-access-token": key,
          "Content-Type": "application/json"
        },
        // Cache the result for 8 hours (28,800 seconds)
        next: { revalidate: 28800 }
      });

      if (response.ok) {
        data = await response.json();
        success = true;
        break; // Exit loop on successful response
      } else {
        // Log error for this key and try the next one
        lastError = new Error(`Key ${key} failed with status ${response.status}`);
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error('Unknown error');
    }
  }

  // If none of the keys succeeded, return an error response.
  if (!success) {
    console.error("Error fetching gold data:", lastError);
    return new NextResponse(
      JSON.stringify({ error: "Failed to fetch gold data with available API keys" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Determine which price to return based on the query parameter.
  const price = grams ? data.price_gram_24k : data.price;

  return new NextResponse(JSON.stringify({ price }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
