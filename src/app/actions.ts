'use server';

import type { ChartDataPoint, Signal } from '@/lib/types';
import { fetchWalletBalance, placeOrder, setLeverage, type BybitBalance } from '@/lib/bybit';

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
    const side = signal.type === 'BUY' ? 'Buy' : 'Sell';
    const leverage = '75';

    // 1. Set leverage
    const leverageResponse = await setLeverage(apiKey, apiSecret, symbol, leverage);
    // Bybit returns retCode 110025 if leverage is already set to the desired value.
    // We can treat this as a success and continue.
    if (leverageResponse.retCode !== 0 && leverageResponse.retMsg !== 'leverage not modified') {
      console.error('Set Leverage Error:', leverageResponse);
      throw new Error(`Failed to set leverage: ${leverageResponse.retMsg}`);
    }
     if (leverageResponse.retCode !== 0 && leverageResponse.retMsg === 'leverage not modified') {
        console.warn(`Leverage already set to ${leverage}. Proceeding with trade.`);
     }


    // 2. Fetch wallet balance to calculate quantity
    const balanceResponse = await fetchWalletBalance(apiKey, apiSecret);
    if (balanceResponse.retCode !== 0) {
      console.error('Fetch Balance Error:', balanceResponse);
      throw new Error(`Failed to fetch balance: ${balanceResponse.retMsg}`);
    }
    const usdtBalance = balanceResponse.result.list.find(c => c.coin === 'USDT');
    if (!usdtBalance) {
      throw new Error('USDT balance not found.');
    }

    // 3. Calculate order quantity
    const walletBalance = parseFloat(usdtBalance.walletBalance);
    const positionValue = walletBalance * 0.1 * parseFloat(leverage); // 10% of balance with leverage
    const orderQty = (positionValue / lastPrice).toFixed(0); // DOGE qty, rounded to nearest integer

     if (parseFloat(orderQty) <= 0) {
      throw new Error('Calculated order quantity is zero or less. Cannot place trade.');
    }


    // 4. Place the order
    const orderResponse = await placeOrder(apiKey, apiSecret, {
      category: 'linear',
      symbol,
      side,
      orderType: 'Market',
      qty: orderQty,
    });

    if (orderResponse.retCode !== 0) {
      console.error('Place Order Error:', orderResponse);
      throw new Error(`Failed to place order: ${orderResponse.retMsg}`);
    }

    return {
      success: true,
      message: 'Trade executed successfully!',
      orderId: orderResponse.result.orderId,
    };
  } catch (error) {
    console.error('Error in executeTrade:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
    return { success: false, message: errorMessage };
  }
}
