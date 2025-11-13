
import { NextResponse, type NextRequest } from 'next/server';
import type { ChartDataPoint } from '@/lib/types';

interface BinanceKlineResponse extends Array<string | number> {}

async function fetchChartDataFromBinance(symbol: 'DOGEUSDT' = 'DOGEUSDT', limit: number = 200): Promise<ChartDataPoint[]> {
  try {
    const host = 'https://api.binance.com';
    const path = '/api/v3/klines';
    const params = new URLSearchParams({
      symbol: symbol,
      interval: '1m', // 1 minute
      limit: limit.toString(),
    });
    const url = `${host}${path}?${params.toString()}`;

    const response = await fetch(url, {
      next: { revalidate: 10 }, // Revalidate every 10 seconds
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Binance-API] HTTP Error (${symbol}): ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Failed to fetch chart data for ${symbol}: ${response.statusText}`);
    }

    const data: BinanceKlineResponse[] = await response.json();

    if (!Array.isArray(data)) {
        throw new Error(`[Binance-API] API returned an invalid format for ${symbol}`);
    }

    const formattedData = data.map(d => ({
      time: Number(d[0]),
      open: parseFloat(d[1] as string),
      high: parseFloat(d[2] as string),
      low: parseFloat(d[3] as string),
      close: parseFloat(d[4] as string),
      volume: parseFloat(d[5] as string),
    })).sort((a, b) => a.time - b.time);

    return formattedData;
  } catch (error) {
    console.error(`[Binance-API] CRITICAL: Unhandled error in fetchChartDataFromBinance for ${symbol}. Re-throwing.`, error);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 200;

  if (isNaN(limit) || limit <= 0) {
    return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
  }

  try {
    const data = await fetchChartDataFromBinance('DOGEUSDT', limit);
    return NextResponse.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    console.error('[API-ChartData] Error fetching chart data:', error);
    return NextResponse.json({ error: `Failed to fetch chart data: ${errorMessage}` }, { status: 500 });
  }
}
