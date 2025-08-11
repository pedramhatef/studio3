import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// TRADING STRATEGY CONFIGURATION
// =================================================================================

// System 1: Core Trend-Following (High Probability)
const EMA_FAST_PERIOD = 3;
const EMA_SLOW_PERIOD = 9;
const EMA_MEDIUM_PERIOD = 20;  // ADDED: Medium-term trend filter
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;

// System 2: Momentum-Reversal (Medium Probability)
const RSI_PERIOD = 7;
const RSI_OVERSOLD_THRESHOLD = 28;
const RSI_OVERBOUGHT_THRESHOLD = 70;  // CHANGED: 65 → 70 to reduce false sells
const DEEP_RSI_THRESHOLD = 22;      // ADDED: Extreme oversold level
const BBANDS_DEEP_MULTIPLIER = 1.8; // ADDED: Wider bands for deep signals
const BBANDS_PERIOD = 12;
const BBANDS_STD_DEV = 1.2;
const VOLUME_SPIKE_FACTOR = 1.3;    // Reduced volume requirement


// System 3: Momentum Shift (Low Probability)
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
    const emaFast = indicators.calculateEMA(closePrices, EMA_FAST_PERIOD);
    const emaSlow = indicators.calculateEMA(closePrices, EMA_SLOW_PERIOD);
    const emaMedium = indicators.calculateEMA(closePrices, EMA_MEDIUM_PERIOD); // ADDED
    const pSar = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwap = indicators.calculateVWAP(chartData);
    const rsi = indicators.calculateRSI(closePrices, RSI_PERIOD);
    const bbands = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV);

    const deepBbands = indicators.calculateBollingerBands(
      closePrices, 
      BBANDS_PERIOD, 
      BBANDS_STD_DEV * BBANDS_DEEP_MULTIPLIER
    );

    

    // Get latest values
    const latestEmaFast = emaFast[emaFast.length - 1];
    const latestEmaSlow = emaSlow[emaSlow.length - 1];
    const latestEmaMedium = emaMedium[emaMedium.length - 1]; // ADDED
    const latestPSar = pSar[pSar.length - 1];
    const latestVwap = vwap[vwap.length - 1];
    const latestRsi = rsi[rsi.length - 1];
    const previousRsi = rsi[rsi.length - 2];
    const latestLowerBB = bbands.lower[bbands.lower.length - 1];
    const latestUpperBB = bbands.upper[bbands.upper.length - 1];
    const latestDeepLowerBB = deepBbands.lower[deepBbands.lower.length - 1];

    
    // Log indicator values for debugging
    console.log("Latest Data Point:", {
        price: latestDataPoint.close.toFixed(5),
        high: latestDataPoint.high.toFixed(5),
        low: latestDataPoint.low.toFixed(5),
        volume: latestDataPoint.volume,
        time: new Date(latestDataPoint.time).toLocaleTimeString()
    });
    console.log("Calculated Indicators:", {
        emaFast: latestEmaFast?.toFixed(5) || 'N/A',
        emaSlow: latestEmaSlow?.toFixed(5) || 'N/A',
        emaMedium: latestEmaMedium?.toFixed(5) || 'N/A', // ADDED
        pSar: latestPSar?.toFixed(5) || 'N/A',
        vwap: latestVwap?.toFixed(5) || 'N/A',
        rsi: latestRsi?.toFixed(2) || 'N/A',
        previousRsi: previousRsi?.toFixed(2) || 'N/A',
        lowerBB: latestLowerBB?.toFixed(5) || 'N/A',
        upperBB: latestUpperBB?.toFixed(5) || 'N/A',
    });

    // Ensure all required indicator values are calculated
    const allIndicatorsAvailable = [latestEmaFast, latestEmaSlow, latestDeepLowerBB , latestEmaMedium  // ADDED
      , latestPSar, latestVwap, latestRsi, previousRsi, latestLowerBB, latestUpperBB].every(v => v !== null && v !== undefined);
    if (!allIndicatorsAvailable) {
      const message = 'Could not calculate all required indicator values.';
      console.log(message);
      return NextResponse.json({ message });
    }
  

    // Helper: log condition status
    function logCondition(name: string, passed: boolean, details?: string) {
      console.log(`    [${passed ? '✔' : '✘'}] ${name}${details ? ` → ${details}` : ''}`);
    }

    let newSignal: Omit<Signal, 'displayTime' | 'serverTime'> | null = null;

    // =================================================================
    // System 1: Core Trend-Following (High Probability)
    // =================================================================
    console.log("\nEvaluating Core Trend-Following System (High):");

    const coreBuyC1 = latestEmaFast! > latestEmaSlow!;
    const coreBuyC2 = latestDataPoint.close > latestVwap!;
    const coreBuyC3 = latestDataPoint.close > latestPSar!;
    const coreBuyC4 = latestRsi! < 65;

    const isCoreBuySignal = coreBuyC1 && coreBuyC2 && coreBuyC3 && coreBuyC4;
    logCondition("EMA(3) > EMA(9)", coreBuyC1, `${latestEmaFast!.toFixed(5)} vs ${latestEmaSlow!.toFixed(5)}`);
    logCondition("Price > VWAP", coreBuyC2, `${latestDataPoint.close.toFixed(5)} vs ${latestVwap!.toFixed(5)}`);
    logCondition("Price > PSAR", coreBuyC3, `${latestDataPoint.close.toFixed(5)} vs ${latestPSar!.toFixed(5)}`);
    logCondition("RSI < 65", coreBuyC4, latestRsi!.toFixed(2));

    const coreSellC1 = latestEmaFast! < latestEmaSlow!;
    const coreSellC2 = latestDataPoint.close < latestVwap!;
    const coreSellC3 = latestDataPoint.close < latestPSar!;
    const coreSellC4 = latestRsi! > 40;
    const coreSellC5 = latestDataPoint.close < latestEmaMedium!;  // ADDED: Medium-term trend filter


    const isCoreSellSignal = coreSellC1 && coreSellC2 && coreSellC3 && coreSellC4 && coreSellC5;
    logCondition("EMA(3) < EMA(9)", coreSellC1, `${latestEmaFast!.toFixed(5)} vs ${latestEmaSlow!.toFixed(5)}`);
    logCondition("Price < VWAP", coreSellC2, `${latestDataPoint.close.toFixed(5)} vs ${latestVwap!.toFixed(5)}`);
    logCondition("Price < PSAR", coreSellC3, `${latestDataPoint.close.toFixed(5)} vs ${latestPSar!.toFixed(5)}`);
    logCondition("RSI > 40", coreSellC4, latestRsi!.toFixed(2));
    logCondition("Price < EMA(20)", coreSellC5, `${latestDataPoint.close.toFixed(5)} vs ${latestEmaMedium!.toFixed(5)}`); // ADDED

    

    if (isCoreBuySignal) {
      newSignal = { type: 'BUY', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
      console.log('✅ New HIGH-CONFIDENCE BUY signal generated.');
    } else if (isCoreSellSignal) {
      newSignal = { type: 'SELL', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
      console.log('✅ New HIGH-CONFIDENCE SELL signal generated.');
    } else {
      console.log("❌ Core system: No signal. Above conditions not all met.");
    }

    // =================================================================
// System 2: Momentum-Reversal (Enhanced Probability)
// =================================================================
if (!newSignal) {
  console.log("\nEvaluating Enhanced Momentum-Reversal System:");

  // -------------------------------------------------------------
  // 1. DEEP OVERSOLD REVERSAL (High Confidence) - Checked FIRST
  // -------------------------------------------------------------
  console.log("\nChecking Deep Oversold Reversal (High Confidence):");
  
  const deepBuyC1 = latestRsi! <= DEEP_RSI_THRESHOLD;
  const deepBuyC2 = latestDataPoint.low <= latestDeepLowerBB!;
  const deepBuyC3 = latestDataPoint.close > latestDataPoint.open;
  const deepBuyC4 = latestDataPoint.volume > (previousDataPoint?.volume || 0) * VOLUME_SPIKE_FACTOR;
  const deepBuyC5 = latestDataPoint.close > latestPSar!;
  
  const isDeepBuySignal = deepBuyC1 && deepBuyC2 && deepBuyC3 && deepBuyC4 && deepBuyC5;
  
  // Log deep conditions
  logCondition(`RSI <= ${DEEP_RSI_THRESHOLD}`, deepBuyC1, latestRsi!.toFixed(2));
  logCondition("Low <= Deep Lower BB", deepBuyC2, `${latestDataPoint.low.toFixed(5)} vs ${latestDeepLowerBB!.toFixed(5)}`);
  logCondition("Bullish Candle", deepBuyC3, `Close:${latestDataPoint.close.toFixed(5)} > Open:${latestDataPoint.open.toFixed(5)}`);
  logCondition(`Volume > ${VOLUME_SPIKE_FACTOR}x Prev`, deepBuyC4, `${latestDataPoint.volume} vs ${previousDataPoint?.volume}`);
  logCondition("Price > PSAR", deepBuyC5, `${latestDataPoint.close.toFixed(5)} vs ${latestPSar!.toFixed(5)}`);

  if (isDeepBuySignal) {
    newSignal = { type: 'BUY', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
    console.log('🔥 New HIGH-CONFIDENCE DEEP BUY signal generated.');
  } else {
    console.log("❌ Deep reversal conditions not fully met");
  }

  // -------------------------------------------------------------
  // 2. MODERATE REVERSAL BUY (Medium Confidence)
  // -------------------------------------------------------------
  if (!newSignal) {
    console.log("\nChecking Moderate Reversal Buy (Medium Confidence):");
    
    const modBuyC1 = previousRsi! < RSI_OVERSOLD_THRESHOLD;
    const modBuyC2 = latestRsi! > RSI_OVERSOLD_THRESHOLD;
    const modBuyC3 = latestDataPoint.low <= latestLowerBB!;
    const modBuyC4 = latestDataPoint.close > latestVwap!;
    const modBuyC5 = latestDataPoint.close > latestEmaSlow!;
    const modBuyC6 = latestDataPoint.close > latestEmaMedium!;
    
    const isModerateBuySignal = modBuyC1 && modBuyC2 && modBuyC3 && modBuyC4 && modBuyC5 && modBuyC6;
    
    // Log moderate conditions
    logCondition(`Prev RSI < ${RSI_OVERSOLD_THRESHOLD}`, modBuyC1, `${previousRsi!.toFixed(2)} < ${RSI_OVERSOLD_THRESHOLD}`);
    logCondition(`Curr RSI > ${RSI_OVERSOLD_THRESHOLD}`, modBuyC2, `${latestRsi!.toFixed(2)} > ${RSI_OVERSOLD_THRESHOLD}`);
    logCondition("Low <= LowerBB", modBuyC3, `${latestDataPoint.low.toFixed(5)} <= ${latestLowerBB!.toFixed(5)}`);
    logCondition("Price > VWAP", modBuyC4, `${latestDataPoint.close.toFixed(5)} > ${latestVwap!.toFixed(5)}`);
    logCondition("Price > EMA(9)", modBuyC5, `${latestDataPoint.close.toFixed(5)} > ${latestEmaSlow!.toFixed(5)}`);
    logCondition("Price > EMA(20)", modBuyC6, `${latestDataPoint.close.toFixed(5)} > ${latestEmaMedium!.toFixed(5)}`);

  if (isModerateBuySignal) {
      newSignal = { type: 'BUY', level: 'Medium', price: latestDataPoint.close, time: latestDataPoint.time };
      console.log('✅ New MEDIUM-CONFIDENCE BUY signal generated.');
    } else {
      console.log("❌ Moderate reversal conditions not fully met");
    }
  }

  // -------------------------------------------------------------
  // 3. REVERSAL SELL (Medium Confidence)
  // -------------------------------------------------------------
   if (!newSignal) {
    console.log("\nChecking Reversal Sell (Medium Confidence):");
    
    const revSellC1 = previousRsi! > RSI_OVERBOUGHT_THRESHOLD;
    const revSellC2 = latestRsi! < RSI_OVERBOUGHT_THRESHOLD;
    const revSellC3 = latestDataPoint.high >= latestUpperBB!;
    const revSellC4 = latestDataPoint.close < latestVwap!;
    const revSellC5 = latestDataPoint.close < latestEmaSlow!;
    const revSellC6 = latestDataPoint.close < latestEmaMedium!;
    
    const isReversalSellSignal = revSellC1 && revSellC2 && revSellC3 && revSellC4 && revSellC5 && revSellC6;
    
    logCondition("Prev RSI > Overbought", revSellC1, `${previousRsi!.toFixed(2)} > ${RSI_OVERBOUGHT_THRESHOLD}`);
    logCondition("Curr RSI < Overbought", revSellC2, `${latestRsi!.toFixed(2)} < ${RSI_OVERBOUGHT_THRESHOLD}`);
    logCondition("High >= UpperBB", revSellC3, `${latestDataPoint.high.toFixed(5)} >= ${latestUpperBB!.toFixed(5)}`);
    logCondition("Price < VWAP", revSellC4, `${latestDataPoint.close.toFixed(5)} < ${latestVwap!.toFixed(5)}`);
    logCondition("Price < EMA(9)", revSellC5, `${latestDataPoint.close.toFixed(5)} < ${latestEmaSlow!.toFixed(5)}`);
    logCondition("Price < EMA(20)", revSellC6, `${latestDataPoint.close.toFixed(5)} vs ${latestEmaMedium!.toFixed(5)}`);

    if (isReversalSellSignal) {
      newSignal = { type: 'SELL', level: 'Medium', price: latestDataPoint.close, time: latestDataPoint.time };
      console.log('✅ New MEDIUM-CONFIDENCE SELL signal generated.');
    } else {
      console.log("❌ Reversal sell conditions not met");
    }
  }
}
  
    // =================================================================
    // System 3: Momentum Shift (Low Probability)
    // =================================================================
    if (!newSignal) {
      console.log("\nEvaluating Momentum Shift System (Low):");

      const volumeUp = latestDataPoint.volume > (previousDataPoint?.volume || 0);
      const shiftBuyC1 = previousRsi! < RSI_CENTERLINE;
      const shiftBuyC2 = latestRsi! > RSI_CENTERLINE;
      const shiftBuyC3 = volumeUp;
      const shiftBuyC4 = latestDataPoint.close > latestVwap!;

      const isRsiBuyCross = shiftBuyC1 && shiftBuyC2 && shiftBuyC3 && shiftBuyC4;
      logCondition("Prev RSI < 50", shiftBuyC1, previousRsi!.toFixed(2));
      logCondition("Curr RSI > 50", shiftBuyC2, latestRsi!.toFixed(2));
      logCondition("Volume Increased", shiftBuyC3, `${latestDataPoint.volume} vs ${previousDataPoint?.volume}`);
      logCondition("Price > VWAP", shiftBuyC4, `${latestDataPoint.close.toFixed(5)} > ${latestVwap!.toFixed(5)}`);

      const shiftSellC1 = previousRsi! > RSI_CENTERLINE;
      const shiftSellC2 = latestRsi! < RSI_CENTERLINE;
      const shiftSellC3 = volumeUp;
      const shiftSellC4 = latestDataPoint.close < latestVwap!;

      const isRsiSellCross = shiftSellC1 && shiftSellC2 && shiftSellC3 && shiftSellC4;
      logCondition("Prev RSI > 50", shiftSellC1, previousRsi!.toFixed(2));
      logCondition("Curr RSI < 50", shiftSellC2, latestRsi!.toFixed(2));
      logCondition("Volume Increased", shiftSellC3, `${latestDataPoint.volume} vs ${previousDataPoint?.volume}`);
      logCondition("Price < VWAP", shiftSellC4, `${latestDataPoint.close.toFixed(5)} < ${latestVwap!.toFixed(5)}`);

      if (isRsiBuyCross) {
        newSignal = { type: 'BUY', level: 'Low', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New LOW-CONFIDENCE BUY signal generated.');
      } else if (isRsiSellCross) {
        newSignal = { type: 'SELL', level: 'Low', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New LOW-CONFIDENCE SELL signal generated.');
      } else {
        console.log("❌ Shift system: No signal.");
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
    
    // Optionally: Save signal to Firestore, or return it
    if (newSignal) {
      await saveSignalToFirestore(newSignal);
      return NextResponse.json({ signal: newSignal });
    } else {
      return NextResponse.json({ message: 'No signal generated.' });
    }    
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: String(error) });
  }
}