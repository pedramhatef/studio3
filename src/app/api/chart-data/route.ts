
import { NextResponse, type NextRequest } from 'next/server';
import { getChartData as fetchChartData } from '@/app/actions';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 200;

  if (isNaN(limit) || limit <= 0) {
    return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
  }

  try {
    const data = await fetchChartData('DOGEUSDT', limit);
    return NextResponse.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    console.error('[API-ChartData] Error fetching chart data:', error);
    return NextResponse.json({ error: `Failed to fetch chart data: ${errorMessage}` }, { status: 500 });
  }
}
