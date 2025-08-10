
// src/app/api/cron/route.ts
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// TRADING STRATEGY CONFIGURATION
// =================================================================================

// System 1: Core Trend-Following (High Probability)
const EMA_FAST_PERIOD = 5;
const EMA_SLOW_PERIOD = 15;
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;

// System 2: Momentum-Reversal (Medium Probability)
const RSI_PERIOD = 9;
const RSI_OVERSOLD_THRESHOLD = 30;
const RSI_OVERBOUGHT_THRESHOLD = 70; // New: For sell signals
const BBANDS_PERIOD = 14;
const BBANDS_STD_DEV = 1.5;

// System 3: Momentum Shift (Low Probability)
// RSI_PERIOD is already defined above.
const RSI_CENTERLINE = 50;


/**
 * This function is the entry point for the cron job, executed every minute.
 * It implements the trading strategies to generate signals.
 */
export async function GET() {
  console.log(`\n--- Cron job triggered at ${new Date().toISOString()} ---`);

  try {
    // 1. Fetch Latest Market Data
    const chartData = await getChartData();
    if (chartData.length < Math.max(EMA_SLOW_PERIOD, BBANDS_PERIOD, RSI_PERIOD)) {
      const message = 'Not enough data to calculate indicators.';
      console.log(message);
      return NextResponse.json({ message });
    }

    const closePrices = chartData.map(d => d.close);
    const latestDataPoint = chartData[chartData.length - 1];
    const previousDataPoint = chartData[chartData.length - 2];

    // 2. Calculate All Necessary Indicators
    // Core Trend-Following Indicators
    const emaFast = indicators.calculateEMA(closePrices, EMA_FAST_PERIOD);
    const emaSlow = indicators.calculateEMA(closePrices, EMA_SLOW_PERIOD);
    const pSar = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwap = indicators.calculateVWAP(chartData);

    // Momentum-Reversal & Momentum Shift Indicators
    const rsi = indicators.calculateRSI(closePrices, RSI_PERIOD);
    const bbands = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV);

    // Get latest values
    const latestEmaFast = emaFast[emaFast.length - 1];
    const latestEmaSlow = emaSlow[emaSlow.length - 1];
    const latestPSar = pSar[pSar.length - 1];
    const latestVwap = vwap[vwap.length - 1];
    const latestRsi = rsi[rsi.length - 1];
    const previousRsi = rsi[rsi.length - 2];
    const latestLowerBB = bbands.lower[bbands.lower.length - 1];
    const latestUpperBB = bbands.upper[bbands.upper.length - 1]; // New: For sell signals
    
    // Log indicator values for debugging
    console.log("Latest Data Point:", {
        price: latestDataPoint.close.toFixed(5),
        high: latestDataPoint.high.toFixed(5),
        low: latestDataPoint.low.toFixed(5),
        time: new Date(latestDataPoint.time).toLocaleTimeString()
    });
    console.log("Calculated Indicators:", {
        emaFast: latestEmaFast?.toFixed(5) || 'N/A',
        emaSlow: latestEmaSlow?.toFixed(5) || 'N/A',
        pSar: latestPSar?.toFixed(5) || 'N/A',
        vwap: latestVwap?.toFixed(5) || 'N/A',
        rsi: latestRsi?.toFixed(2) || 'N/A',
        previousRsi: previousRsi?.toFixed(2) || 'N/A',
        lowerBB: latestLowerBB?.toFixed(5) || 'N/A',
        upperBB: latestUpperBB?.toFixed(5) || 'N/A',
    });


    // Ensure all required indicator values are calculated
    const allIndicatorsAvailable = [latestEmaFast, latestEmaSlow, latestPSar, latestVwap, latestRsi, previousRsi, latestLowerBB, latestUpperBB].every(v => v !== null && v !== undefined);
    if (!allIndicatorsAvailable) {
      const message = 'Could not calculate all required indicator values.';
      console.log(message);
      return NextResponse.json({ message });
    }

    let newSignal: Omit<Signal, 'displayTime' | 'serverTime'> | null = null;

    // 3. Apply Trading Logic, prioritizing as requested (Low -> Medium -> High)
    // =================================================================
    // System 3: Momentum Shift (Low Probability)
    // Check this first as it is the most common.
    // =================================================================
    const isRsiBuyCross = previousRsi! < RSI_CENTERLINE && latestRsi! > RSI_CENTERLINE;
    const isRsiSellCross = previousRsi! > RSI_CENTERLINE && latestRsi! < RSI_CENTERLINE;

    console.log("\nEvaluating Momentum Shift System (Low):");
    console.log(`  - BUY Condition: PrevRSI<50 AND CurrRSI>50`);
    console.log(`    - Result: ${previousRsi! < RSI_CENTERLINE} AND ${latestRsi! > RSI_CENTERLINE} -> ${isRsiBuyCross}`);
    console.log(`  - SELL Condition: PrevRSI>50 AND CurrRSI<50`);
    console.log(`    - Result: ${previousRsi! > RSI_CENTERLINE} AND ${latestRsi! < RSI_CENTERLINE} -> ${isRsiSellCross}`);
    
    if (isRsiBuyCross) {
        newSignal = {
            type: 'BUY',
            level: 'Low',
            price: latestDataPoint.close,
            time: latestDataPoint.time,
        };
        console.log('✅ New LOW-CONFIDENCE BUY signal generated.');
    } else if (isRsiSellCross) {
        newSignal = {
            type: 'SELL',
            level: 'Low',
            price: latestDataPoint.close,
            time: latestDataPoint.time,
        };
        console.log('✅ New LOW-CONFIDENCE SELL signal generated.');
    }

    // =================================================================
    // System 2: Momentum-Reversal System (Medium Probability)
    // Only check if no low-probability signal was found.
    // =================================================================
    if (!newSignal) {
        const isReversalBuySignal = previousRsi! < RSI_OVERSOLD_THRESHOLD && latestRsi! > RSI_OVERSOLD_THRESHOLD && latestDataPoint.low <= latestLowerBB! && latestDataPoint.close > latestVwap!;
        // New: Sell signal logic
        const isReversalSellSignal = previousRsi! > RSI_OVERBOUGHT_THRESHOLD && latestRsi! < RSI_OVERBOUGHT_THRESHOLD && latestDataPoint.high >= latestUpperBB! && latestDataPoint.close < latestVwap!;

        console.log("\nEvaluating Momentum-Reversal System (Medium):");
        console.log(`  - BUY Condition: PrevRSI<30 AND CurrRSI>30 AND Low<=LowerBB AND Price>VWAP`);
        console.log(`    - Result: ${previousRsi! < RSI_OVERSOLD_THRESHOLD} AND ${latestRsi! > RSI_OVERSOLD_THRESHOLD} AND ${latestDataPoint.low <= latestLowerBB!} AND ${latestDataPoint.close > latestVwap!} -> ${isReversalBuySignal}`);
        console.log(`  - SELL Condition: PrevRSI>70 AND CurrRSI<70 AND High>=UpperBB AND Price<VWAP`);
        console.log(`    - Result: ${previousRsi! > RSI_OVERBOUGHT_THRESHOLD} AND ${latestRsi! < RSI_OVERBOUGHT_THRESHOLD} AND ${latestDataPoint.high >= latestUpperBB!} AND ${latestDataPoint.close < latestVwap!} -> ${isReversalSellSignal}`);

        if (isReversalBuySignal) {
            newSignal = {
                type: 'BUY',
                level: 'Medium',
                price: latestDataPoint.close,
                time: latestDataPoint.time,
            };
            console.log('✅ New MEDIUM-CONFIDENCE BUY signal generated.');
        } else if (isReversalSellSignal) {
            newSignal = {
                type: 'SELL',
                level: 'Medium',
                price: latestDataPoint.close,
                time: latestDataPoint.time,
            };
            console.log('✅ New MEDIUM-CONFIDENCE SELL signal generated.');
        }
    }


    // =================================================================
    // System 1: Core Trend-Following System (High Probability)
    // Only check if no other signal was found.
    // =================================================================
    if (!newSignal) {
        const isCoreBuySignal = latestEmaFast! > latestEmaSlow! && latestDataPoint.close > latestVwap! && latestDataPoint.close > latestPSar!;
        // Refined: Changed OR to AND for a more robust signal
        const isCoreSellSignal = latestEmaFast! < latestEmaSlow! && latestDataPoint.close < latestPSar!;
        
        console.log("\nEvaluating Core Trend-Following System (High):");
        console.log(`  - BUY Condition: EMA(5)>EMA(15) AND Price>VWAP AND Price>PSAR`);
        console.log(`    - Result: ${latestEmaFast! > latestEmaSlow!} AND ${latestDataPoint.close > latestVwap!} AND ${latestDataPoint.close > latestPSar!} -> ${isCoreBuySignal}`);
        console.log(`  - SELL Condition: EMA(5)<EMA(15) AND Price<PSAR`);
        console.log(`    - Result: ${latestEmaFast! < latestEmaSlow!} AND ${latestDataPoint.close < latestPSar!} -> ${isCoreSellSignal}`);
    
        if (isCoreBuySignal) {
            newSignal = {
                type: 'BUY',
                level: 'High',
                price: latestDataPoint.close,
                time: latestDataPoint.time,
            };
            console.log('✅ New HIGH-CONFIDENCE BUY signal generated.');
        } else if (isCoreSellSignal) {
            newSignal = {
                type: 'SELL',
                level: 'High',
                price: latestDataPoint.close,
                time: latestDataPoint.time,
            };
            console.log('✅ New HIGH-CONFIDENCE SELL signal generated.');
        }
    }


    if (!newSignal) {
        console.log('\nNo new signal generated. Conditions not met for any system.');
        return NextResponse.json({ message: 'No new signal generated based on current strategy.' });
    }

    // 4. Prevent Consecutive Duplicate Signals
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals.length > 0 ? lastSignals[0] : null;

    if (lastSignal) {
      console.log(`Last signal was '${lastSignal.type}' with '${lastSignal.level}' confidence. New signal is '${newSignal.type}' with '${newSignal.level}' confidence.`);
    } else {
      console.log('No previous signals found in history.');
    }

    // Prevent a signal if the type AND level are the same as the last one.
    if (lastSignal && newSignal.type === lastSignal.type && newSignal.level === lastSignal.level) {
        const message = `Skipping save. New signal '${newSignal.type} (${newSignal.level})' is identical to the last signal.`;
        console.log(`❌ ${message}`);
        return NextResponse.json({ message });
    }

    // 5. Save the New, Unique Signal to Firestore
    const result = await saveSignalToFirestore(newSignal);
    if(result.success) {
      console.log(`🚀 Successfully saved ${newSignal.type} signal (${newSignal.level} confidence) to Firestore.`);
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
