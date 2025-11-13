
import { NextResponse, type NextRequest } from 'next/server';
import type { ChartDataPoint } from '@/lib/types';

interface BybitKlineResponse {
  retCode: number;
  retMsg: string;
  result: {
    symbol: string;
    category: string;
    list: [string, string, string, string, string, string, string][];
  };
  retExtInfo: {};
  time: number;
}

async function fetchChartDataFromBybit(symbol: 'DOGEUSDT' = 'DOGEUSDT', limit: number = 200): Promise<ChartDataPoint[]> {
  try {
    const host = 'https://api.bytick.com';
    const path = '/v5/market/kline';
    const params = new URLSearchParams({
      category: 'linear',
      symbol: symbol,
      interval: '1', // 1 minute
      limit: limit.toString(),
    });
    const url = `${host}${path}?${params.toString()}`;

    const response = await fetch(url, {
      next: { revalidate: 10 }, // Revalidate every 10 seconds
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Bybit-API] HTTP Error (${symbol}): ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Failed to fetch chart data for ${symbol}: ${response.statusText}`);
    }

    const data: BybitKlineResponse = await response.json();

    if (data.retCode !== 0) {
      throw new Error(`[Bybit-API] API returned an error for ${symbol}: ${data.retMsg}`);
    }

    const formattedData = data.result.list.map(d => ({
      time: parseInt(d[0]),
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    })).sort((a, b) => a.time - b.time);

    return formattedData;
  } catch (error) {
    console.error(`[Bybit-API] CRITICAL: Unhandled error in fetchChartDataFromBybit for ${symbol}. Re-throwing.`, error);
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
    const data = await fetchChartDataFromBybit('DOGEUSDT', limit);
    return NextResponse.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    console.error('[API-ChartData] Error fetching chart data:', error);
    return NextResponse.json({ error: `Failed to fetch chart data: ${errorMessage}` }, { status: 500 });
  }
}
