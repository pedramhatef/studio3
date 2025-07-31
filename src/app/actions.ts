'use server';

import type { ChartDataPoint, Signal } from '@/lib/types';
import { fetchWalletBalance, placeOrder, setLeverage, type BybitBalance, getPositions, BybitPosition } from '@/lib/bybit';

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

export async function getChartData(): Promise<ChartDataPoint[]> {
  try {
    const host = 'https://api-demo.bybit.com';
    const path = '/v5/market/kline';
    const params = new URLSearchParams({
      category: 'linear',
      symbol: 'DOGEUSDT',
      interval: '1', // 1 minute
      limit: '200', // max limit
    });
    const url = `${host}${path}?${params.toString()}`;

    const response = await fetch(url, {
      next: { revalidate: 10 }, // Revalidate every 10 seconds
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Bybit Chart API Error:', errorText);
      throw new Error(`Failed to fetch chart data: ${response.statusText}`);
    }

    const data: BybitKlineResponse = await response.json();

    if (data.retCode !== 0) {
      throw new Error(`Bybit API returned an error: ${data.retMsg}`);
    }

    const formattedData = data.result.list.map(d => ({
      time: parseInt(d[0]),
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    })).sort((a, b) => a.time - b.time); // Ensure data is sorted chronologically

    return formattedData;
  } catch (error) {
    console.error('Error in getChartData:', error);
    return []; // Return empty array on error
  }
}

export async function executeTrade(
  apiKey: string,
  apiSecret: string,
  signal: Signal,
  lastPrice: number,
): Promise<{ success: boolean, message: string, orderId?: string }> {
  try {
    const symbol = 'DOGEUSDT';

    // 1. Check for existing positions
    const positionResponse = await getPositions(apiKey, apiSecret, { category: 'linear', symbol });
    if (positionResponse.retCode !== 0) {
        throw new Error(`Failed to fetch positions: ${positionResponse.retMsg}`);
    }
    const openPositions = positionResponse.result.list.filter((p: BybitPosition) => parseFloat(p.size) > 0);
    if (openPositions.length > 0) {
        const message = `An open position of size ${openPositions[0].size} for ${symbol} already exists. No new trade placed.`;
        console.log(message);
        return { success: true, message: message, orderId: 'EXISTING' };
    }

    const side = signal.type === 'BUY' ? 'Buy' : 'Sell';
    const leverage = '75';

    // 2. Set leverage
    const leverageResponse = await setLeverage(apiKey, apiSecret, symbol, leverage);
    if (leverageResponse.retCode !== 0 && leverageResponse.retMsg !== 'leverage not modified') {
      console.error('Set Leverage Error:', leverageResponse);
      throw new Error(`Failed to set leverage: ${leverageResponse.retMsg}`);
    }
     if (leverageResponse.retCode !== 0 && leverageResponse.retMsg === 'leverage not modified') {
        console.warn(`Leverage already set to ${leverage}. Proceeding with trade.`);
     }

    // 3. Calculate order quantity from fixed value
    const positionValue = 2; // Fixed $2 position value
    const orderQty = (positionValue * parseFloat(leverage) / lastPrice).toFixed(0);

     if (parseFloat(orderQty) <= 0) {
      throw new Error('Calculated order quantity is zero or less. Cannot place trade.');
    }

    // 4. Calculate TP/SL prices
    const takeProfitPrice = side === 'Buy'
        ? (lastPrice * (1 + 0.40)).toFixed(5)
        : (lastPrice * (1 - 0.40)).toFixed(5);
    
    const stopLossPrice = side === 'Buy'
        ? (lastPrice * (1 - 0.65)).toFixed(5)
        : (lastPrice * (1 + 0.65)).toFixed(5);


    // 5. Place the order with TP/SL
    const orderResponse = await placeOrder(apiKey, apiSecret, {
      category: 'linear',
      symbol,
      side,
      orderType: 'Market',
      qty: orderQty,
      takeProfit: takeProfitPrice,
      stopLoss: stopLossPrice,
      tpslMode: 'Full', // 'Full' for entire position
      tpTriggerBy: 'MarkPrice',
      slTriggerBy: 'MarkPrice',
    });

    if (orderResponse.retCode !== 0) {
      console.error('Place Order Error:', orderResponse);
      throw new Error(`Failed to place order: ${orderResponse.retMsg}`);
    }

    return {
      success: true,
      message: 'Trade executed successfully with TP/SL!',
      orderId: orderResponse.result.orderId,
    };
  } catch (error) {
    console.error('Error in executeTrade:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
    return { success: false, message: errorMessage };
  }
}
