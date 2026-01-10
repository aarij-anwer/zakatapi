/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Updates the monthly silver price snapshot.
 * Usage: POST /api/silver/update-monthly?secret=YOUR_SECRET
 *
 * This endpoint should be called at the beginning of each month
 * to store the current silver price as a fallback.
 *
 * You can automate this with:
 * - Vercel Cron Jobs
 * - GitHub Actions scheduled workflow
 * - Manual API call on the 1st of each month
 */
export async function POST(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');

  // Simple secret protection (set UPDATE_MONTHLY_SECRET in env vars)
  const expectedSecret = process.env.UPDATE_MONTHLY_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json(
      { error: 'Unauthorized - invalid or missing secret' },
      { status: 401 }
    );
  }

  try {
    // Fetch current silver price from the main API
    const baseUrl = request.url.replace('/update-monthly', '').split('?')[0];
    const response = await fetch(baseUrl, { cache: 'no-store' });

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch current silver price' },
        { status: 500 }
      );
    }

    const data = await response.json();

    // Verify we got valid data
    if (!data.price_oz || !data.price_gram_24k) {
      return NextResponse.json(
        { error: 'Invalid price data received' },
        { status: 500 }
      );
    }

    // Load existing monthly prices
    const filePath = join(
      process.cwd(),
      'public',
      'silver-monthly-prices.json'
    );
    let monthlyPrices: Record<string, any> = {};

    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      monthlyPrices = JSON.parse(fileContent);
    } catch (error) {
      console.log('[Update Silver Monthly] Creating new monthly prices file');
      monthlyPrices = {};
    }

    // Get current month key (YYYY-MM format)
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, '0')}`;

    // Add/update current month's price
    monthlyPrices[monthKey] = {
      price: data.price_oz,
      price_oz: data.price_oz,
      price_gram_24k: data.price_gram_24k,
      currency: data.currency || 'CAD',
      provider: data.provider,
      cached: true,
      timestamp: now.toISOString(),
    };

    // Write back to file
    writeFileSync(filePath, JSON.stringify(monthlyPrices, null, 2), 'utf-8');

    console.log(
      `[Update Silver Monthly] Stored price for ${monthKey}: ${data.price_oz} CAD/oz`
    );

    return NextResponse.json({
      success: true,
      month: monthKey,
      price_oz: data.price_oz,
      price_gram_24k: data.price_gram_24k,
      provider: data.provider,
      message: `Successfully stored monthly silver price for ${monthKey}`,
    });
  } catch (error) {
    console.error('[Update Silver Monthly] Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to update monthly silver price',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
