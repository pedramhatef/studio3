
// src/app/api/cron/route.ts
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// TRADING STRATEGY CONFIGURATION
// =================================================================================
const EMA_FAST_PERIOD = 5;
const EMA_SLOW_PERIOD = 15;
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;

/**
 * This function is the entry point for the cron job, executed every minute.
 * It implements the Core Trend-Following System to generate trading signals.
 */
export async function GET() {
  console.log(`\n--- Cron job triggered at ${new Date().toISOString()} ---`);

  try {
    // 1. Fetch Latest Market Data
    const chartData = await getChartData();
    if (chartData.length < EMA_SLOW_PERIOD) {
      const message = 'Not enough data to calculate indicators.';
      console.log(message);
      return NextResponse.json({ message });
    }

    const closePrices = chartData.map(d => d.close);
    const latestDataPoint = chartData[chartData.length - 1];

    // 2. Calculate Technical Indicators
    const emaFast = indicators.calculateEMA(closePrices, EMA_FAST_PERIOD);
    const emaSlow = indicators.calculateEMA(closePrices, EMA_SLOW_PERIOD);
    const pSar = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwap = indicators.calculateVWAP(chartData);

    const latestEmaFast = emaFast[emaFast.length - 1];
    const latestEmaSlow = emaSlow[emaSlow.length - 1];
    const latestPSar = pSar[pSar.length - 1];
    const latestVwap = vwap[vwap.length - 1];
    
    console.log("Latest Data Point:", {
        price: latestDataPoint.close.toFixed(5),
        time: new Date(latestDataPoint.time).toLocaleTimeString()
    });
    console.log("Calculated Indicators:", {
        emaFast: latestEmaFast?.toFixed(5) || 'N/A',
        emaSlow: latestEmaSlow?.toFixed(5) || 'N/A',
        pSar: latestPSar?.toFixed(5) || 'N/A',
        vwap: latestVwap?.toFixed(5) || 'N/A',
    });


    // Ensure all latest indicator values are calculated
    if (latestEmaFast === null || latestEmaSlow === null || latestPSar === null || latestVwap === null) {
      const message = 'Could not calculate latest indicator values.';
      console.log(message);
      return NextResponse.json({ message });
    }

    let newSignal: Omit<Signal, 'displayTime' | 'serverTime'> | null = null;

    // 3. Apply Trading Logic
    const isBuySignal = latestEmaFast > latestEmaSlow && latestDataPoint.close > latestVwap && latestDataPoint.close > latestPSar;
    const isSellSignal = latestEmaFast < latestEmaSlow || latestDataPoint.close < latestPSar;
    
    console.log("Evaluating Conditions:", {
      isBuySignal,
      isSellSignal
    });
    console.log(`  - EMA(5) > EMA(15)? ${latestEmaFast > latestEmaSlow}`);
    console.log(`  - Price > VWAP? ${latestDataPoint.close > latestVwap}`);
    console.log(`  - Price > PSAR? ${latestDataPoint.close > latestPSar}`);
    console.log(`  - EMA(5) < EMA(15)? ${latestEmaFast < latestEmaSlow}`);
    console.log(`  - Price < PSAR? ${latestDataPoint.close < latestPSar}`);


    if (isBuySignal) {
        newSignal = {
            type: 'BUY',
            level: 'High',
            price: latestDataPoint.close,
            time: latestDataPoint.time,
        };
        console.log('✅ New BUY signal generated based on logic.');
    } else if (isSellSignal) {
        newSignal = {
            type: 'SELL',
            level: 'High',
            price: latestDataPoint.close,
            time: latestDataPoint.time,
        };
        console.log('✅ New SELL signal generated based on logic.');
    }

    if (!newSignal) {
        console.log('No new signal generated. Conditions not met.');
        return NextResponse.json({ message: 'No new signal generated based on current strategy.' });
    }

    // 4. Prevent Consecutive Duplicate Signals
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals.length > 0 ? lastSignals[0] : null;

    if (lastSignal) {
      console.log(`Last signal was '${lastSignal.type}'. New signal is '${newSignal.type}'.`);
    } else {
      console.log('No previous signals found in history.');
    }

    if (lastSignal && newSignal.type === lastSignal.type) {
        const message = `Skipping save. New signal type '${newSignal.type}' is same as last signal.`;
        console.log(`❌ ${message}`);
        return NextResponse.json({ message });
    }

    // 5. Save the New, Unique Signal to Firestore
    const result = await saveSignalToFirestore(newSignal);
    if(result.success) {
      console.log(`🚀 Successfully saved ${newSignal.type} signal to Firestore.`);
      return NextResponse.json({ message: 'Signal generated and saved successfully', signal: newSignal });
    } else {
      console.error('Failed to save signal to Firestore:', result.error);
      return NextResponse.json({ message: 'Failed to save signal', error: result.error }, { status: 500 });
    }

  } catch (error) {
    console.error('Error in cron job:', error);
    return NextResponse.json({ message: 'Error executing cron job', error: (error as Error).message }, { status: 500 });
  }
}
