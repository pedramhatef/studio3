// src/app/api/cron/route.ts
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// TRADING STRATEGY CONFIGURATION - PARAMETERS OPTIMIZED FOR VOLATILITY
// =================================================================================

// System 1: Core Trend-Following (High Probability)
const EMA_FAST_PERIOD = 3;  // More responsive to price changes
const EMA_SLOW_PERIOD = 10;  // Reduced from 15 for faster trend detection
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;

// System 2: Momentum-Reversal (Medium Probability)
const RSI_PERIOD = 7;  // More sensitive RSI
const RSI_OVERSOLD_THRESHOLD = 35;  // Relaxed from 30
const RSI_OVERBOUGHT_THRESHOLD = 65;  // Relaxed from 70
const BBANDS_PERIOD = 12;  // More responsive bands
const BBANDS_STD_DEV = 1.2;  // Tighter bands for volatile markets

// System 3: Momentum Shift (Low Probability)
const RSI_CENTERLINE = 50;

// Signal cooldown (minutes)
const SIGNAL_COOLDOWN = 3;  // Allow new signals every 3 minutes

/**
 * Cron job with optimized parameters for volatile markets
 */
export async function GET() {
  console.log(`\n--- Cron job triggered at ${new Date().toISOString()} ---`);

  try {
    // 1. Fetch Market Data
    const chartData = await getChartData();
    const minDataLength = Math.max(EMA_SLOW_PERIOD, BBANDS_PERIOD, RSI_PERIOD);
    
    if (chartData.length < minDataLength) {
      const message = `Not enough data (${chartData.length}/${minDataLength}).`;
      console.log(message);
      return NextResponse.json({ message });
    }

    const closePrices = chartData.map(d => d.close);
    const latestDataPoint = chartData[chartData.length - 1];
    const previousDataPoint = chartData[chartData.length - 2];

    // 2. Calculate Indicators
    const emaFast = indicators.calculateEMA(closePrices, EMA_FAST_PERIOD);
    const emaSlow = indicators.calculateEMA(closePrices, EMA_SLOW_PERIOD);
    const pSar = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwap = indicators.calculateVWAP(chartData);
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
    const latestUpperBB = bbands.upper[bbands.upper.length - 1];
    
    // Log indicator values
    console.log("Latest Data:", {
        price: latestDataPoint.close.toFixed(5),
        time: new Date(latestDataPoint.time).toLocaleTimeString(),
        emaFast: latestEmaFast?.toFixed(5),
        emaSlow: latestEmaSlow?.toFixed(5),
        rsi: latestRsi?.toFixed(2),
        bb_low: latestLowerBB?.toFixed(5),
        bb_up: latestUpperBB?.toFixed(5),
        sar: latestPSar?.toFixed(5),
        vwap: latestVwap?.toFixed(5),
        volume: latestDataPoint.volume
    });

    // Validate indicator calculations
    const requiredIndicators = [latestEmaFast, latestEmaSlow, latestPSar, latestVwap, latestRsi, previousRsi, latestLowerBB, latestUpperBB];
    if (requiredIndicators.some(v => v === null || v === undefined)) {
      console.log('Missing indicator values. Skipping signal generation.');
      return NextResponse.json({ message: 'Incomplete indicator data' });
    }

    let newSignal: Omit<Signal, 'displayTime' | 'serverTime'> | null = null;

    // =================================================================
    // System 1: Core Trend-Following (High Probability)
    // =================================================================
    const isCoreBuySignal = 
      latestEmaFast! > latestEmaSlow! &&
      latestDataPoint.close > latestVwap! &&
      latestDataPoint.close > latestPSar! &&
      latestRsi! < 65;  // Slightly relaxed RSI filter
    
    const isCoreSellSignal = 
      latestEmaFast! < latestEmaSlow! &&
      latestDataPoint.close < latestVwap! &&
      latestDataPoint.close < latestPSar! &&
      latestRsi! > 35;  // Slightly relaxed RSI filter

    console.log("\nCore System (High):");
    console.log(`  BUY: EMA↑(${latestEmaFast! > latestEmaSlow!}) VWAP↑(${latestDataPoint.close > latestVwap!}) SAR↑(${latestDataPoint.close > latestPSar!}) RSI<65(${latestRsi! < 65}) → ${isCoreBuySignal}`);
    console.log(`  SELL: EMA↓(${latestEmaFast! < latestEmaSlow!}) VWAP↓(${latestDataPoint.close < latestVwap!}) SAR↓(${latestDataPoint.close < latestPSar!}) RSI>35(${latestRsi! > 35}) → ${isCoreSellSignal}`);

    if (isCoreBuySignal) {
      newSignal = { type: 'BUY', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
      console.log('✅ HIGH Buy Signal');
    } else if (isCoreSellSignal) {
      newSignal = { type: 'SELL', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
      console.log('✅ HIGH Sell Signal');
    }

    // =================================================================
    // System 2: Momentum-Reversal (Medium Probability)
    // =================================================================
    if (!newSignal) {
      const isReversalBuySignal = 
        previousRsi! < RSI_OVERSOLD_THRESHOLD && 
        latestRsi! > RSI_OVERSOLD_THRESHOLD &&
        latestDataPoint.low <= latestLowerBB! && 
        latestDataPoint.close > latestVwap! &&
        latestDataPoint.close > latestEmaSlow!;
      
      const isReversalSellSignal = 
        previousRsi! > RSI_OVERBOUGHT_THRESHOLD && 
        latestRsi! < RSI_OVERBOUGHT_THRESHOLD &&
        latestDataPoint.high >= latestUpperBB! && 
        latestDataPoint.close < latestVwap! &&
        latestDataPoint.close < latestEmaSlow!;

      console.log("\nReversal System (Medium):");
      console.log(`  BUY: RSI↑(${previousRsi! < RSI_OVERSOLD_THRESHOLD && latestRsi! > RSI_OVERSOLD_THRESHOLD}) BB↓(${latestDataPoint.low <= latestLowerBB!}) VWAP↑(${latestDataPoint.close > latestVwap!}) EMA↑(${latestDataPoint.close > latestEmaSlow!}) → ${isReversalBuySignal}`);
      console.log(`  SELL: RSI↓(${previousRsi! > RSI_OVERBOUGHT_THRESHOLD && latestRsi! < RSI_OVERBOUGHT_THRESHOLD}) BB↑(${latestDataPoint.high >= latestUpperBB!}) VWAP↓(${latestDataPoint.close < latestVwap!}) EMA↓(${latestDataPoint.close < latestEmaSlow!}) → ${isReversalSellSignal}`);

      if (isReversalBuySignal) {
        newSignal = { type: 'BUY', level: 'Medium', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ MEDIUM Buy Signal');
      } else if (isReversalSellSignal) {
        newSignal = { type: 'SELL', level: 'Medium', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ MEDIUM Sell Signal');
      }
    }

    // =================================================================
    // System 3: Momentum Shift (Low Probability)
    // =================================================================
    if (!newSignal) {
      const volumeUp = latestDataPoint.volume > (previousDataPoint?.volume || 0) * 1.3;  // Require 30% volume increase
      
      const isRsiBuyCross = 
        previousRsi! < RSI_CENTERLINE && 
        latestRsi! > RSI_CENTERLINE &&
        volumeUp &&
        latestDataPoint.close > latestVwap!;
      
      const isRsiSellCross = 
        previousRsi! > RSI_CENTERLINE && 
        latestRsi! < RSI_CENTERLINE &&
        volumeUp &&
        latestDataPoint.close < latestVwap!;

      console.log("\nMomentum System (Low):");
      console.log(`  BUY: RSI✚(${previousRsi! < RSI_CENTERLINE && latestRsi! > RSI_CENTERLINE}) VOL↑(${volumeUp}) VWAP↑(${latestDataPoint.close > latestVwap!}) → ${isRsiBuyCross}`);
      console.log(`  SELL: RSI✖(${previousRsi! > RSI_CENTERLINE && latestRsi! < RSI_CENTERLINE}) VOL↑(${volumeUp}) VWAP↓(${latestDataPoint.close < latestVwap!}) → ${isRsiSellCross}`);
      
      if (isRsiBuyCross) {
        newSignal = { type: 'BUY', level: 'Low', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ LOW Buy Signal');
      } else if (isRsiSellCross) {
        newSignal = { type: 'SELL', level: 'Low', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ LOW Sell Signal');
      }
    }

    // 4. Signal Management
    if (!newSignal) {
      console.log('No signal conditions met');
      return NextResponse.json({ message: 'No signal generated' });
    }

    // Time-based cooldown instead of type-based blocking
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals[0];
    
    if (lastSignal) {
      const lastSignalTime = new Date(lastSignal.serverTime).getTime();
      const currentTime = Date.now();
      const minutesDiff = (currentTime - lastSignalTime) / (1000 * 60);
      
      if (minutesDiff < SIGNAL_COOLDOWN) {
        console.log(`Cooldown active: ${minutesDiff.toFixed(1)}/${SIGNAL_COOLDOWN} minutes`);
        return NextResponse.json({ message: 'Signal skipped: Cooldown period' });
      }
    }

    // Save the signal
    const result = await saveSignalToFirestore(newSignal);
    if (result.success) {
      console.log(`Signal saved: ${newSignal.type} (${newSignal.level})`);
      return NextResponse.json({ message: 'Signal saved', signal: newSignal });
    } else {
      console.error('Save failed:', result.error);
      return NextResponse.json({ message: 'Save error', error: result.error }, { status: 500 });
    }

  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json({ message: 'Server error', error: (error as Error).message }, { status: 500 });
  }
}