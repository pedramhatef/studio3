import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// OPTIMIZED TRADING STRATEGY CONFIGURATION
// =================================================================================

// System 1: Core Trend-Following (High Probability)
const EMA_FAST_PERIOD = 5;
const EMA_SLOW_PERIOD = 13;
const EMA_MEDIUM_PERIOD = 20;
const EMA_LONG_PERIOD = 50;
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;
const TREND_CONFIRMATION_PERIOD = 3;

// System 2: Momentum-Reversal (Medium Probability)
const RSI_PERIOD = 14;
const RSI_OVERSOLD_THRESHOLD = 30;
const RSI_OVERBOUGHT_THRESHOLD = 70;
const DEEP_RSI_THRESHOLD = 25;
const BBANDS_DEEP_MULTIPLIER = 2.0;
const BBANDS_PERIOD = 20;
const BBANDS_STD_DEV = 1.5;
const VOLUME_SPIKE_FACTOR = 1.8;
const MIN_CANDLE_BODY = 0.0003;

// System 3: Momentum Shift (Low Probability)
const RSI_CENTERLINE = 50;
const MIN_VOL_CHANGE = 1.5;

// Volatility Filter
const ATR_PERIOD = 14;
const MIN_ATR_THRESHOLD = 0.00025;
const LOW_VOL_THRESHOLD = 0.0005;

// ====== NEW FILTERS ====== //
const VOLUME_CONFIRMATION_FACTOR = 0.7; // Min 70% of 5-period average
const PRICE_POSITION_FILTER = 0.3; // Require middle 30% of BB width
const RSI_BUY_MAX = 55; // Tightened from 60
const RSI_SELL_MIN = 45; // Tightened from 40
const PSAR_BUFFER_FACTOR = 0.3; // 30% of ATR

/**
 * This function is the entry point for the cron job, executed every minute.
 * It implements the trading strategies to generate signals.
 */
export async function GET() {
  console.log(`\n--- Optimized cron job triggered at ${new Date().toISOString()} ---`);

  try {
    // 1. Fetch Latest Market Data
    const chartData = await getChartData();
    const requiredPeriods = Math.max(
      EMA_SLOW_PERIOD, 
      BBANDS_PERIOD, 
      RSI_PERIOD, 
      ATR_PERIOD,
      EMA_LONG_PERIOD
    );
    
    if (chartData.length < requiredPeriods) {
      const message = 'Not enough data to calculate indicators.';
      console.log(message);
      return NextResponse.json({ message });
    }

    const closePrices = chartData.map(d => d.close);
    const highPrices = chartData.map(d => d.high);
    const lowPrices = chartData.map(d => d.low);
    const latestDataPoint = chartData[chartData.length - 1];
    const previousDataPoint = chartData[chartData.length - 2];
    const prevCandle = chartData[chartData.length - 2];

    // 2. Calculate All Necessary Indicators
    const emaFast = indicators.calculateEMA(closePrices, EMA_FAST_PERIOD);
    const emaSlow = indicators.calculateEMA(closePrices, EMA_SLOW_PERIOD);
    const emaMedium = indicators.calculateEMA(closePrices, EMA_MEDIUM_PERIOD);
    const emaLong = indicators.calculateEMA(closePrices, EMA_LONG_PERIOD);
    const pSar = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwap = indicators.calculateVWAP(chartData);
    const rsi = indicators.calculateRSI(closePrices, RSI_PERIOD);
    const bbands = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV);
    const deepBbands = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV * BBANDS_DEEP_MULTIPLIER);
    const atr = indicators.calculateATR(highPrices, lowPrices, closePrices, ATR_PERIOD);

    // Get latest values
    const latestEmaFast = emaFast[emaFast.length - 1];
    const latestEmaSlow = emaSlow[emaSlow.length - 1];
    const latestEmaMedium = emaMedium[emaMedium.length - 1];
    const latestEmaLong = emaLong[emaLong.length - 1];
    const latestPSar = pSar[pSar.length - 1];
    const latestVwap = vwap[vwap.length - 1];
    const latestRsi = rsi[rsi.length - 1];
    const previousRsi = rsi[rsi.length - 2];
    const latestLowerBB = bbands.lower[bbands.lower.length - 1];
    const latestUpperBB = bbands.upper[bbands.upper.length - 1];
    const latestDeepLowerBB = deepBbands.lower[deepBbands.lower.length - 1];
    const latestAtr = atr[atr.length - 1];

    // Determine long-term trend direction
    const isUptrend = latestDataPoint.close > latestEmaLong!;
    const isDowntrend = latestDataPoint.close < latestEmaLong!;

    // Trend confirmation helpers
    const isIncreasing = (values: (number | null)[]): boolean => {
      const recentValues = values.slice(-TREND_CONFIRMATION_PERIOD);
      if (recentValues.some(v => v === null)) {
        console.log(`   [Trend] Null value found in last ${TREND_CONFIRMATION_PERIOD} periods`);
        return false;
      }
      const numValues = recentValues as number[];
      for (let i = 1; i < numValues.length; i++) {
        if (numValues[i] <= numValues[i-1]) return false;
      }
      return true;
    };

    const isDecreasing = (values: (number | null)[]): boolean => {
      const recentValues = values.slice(-TREND_CONFIRMATION_PERIOD);
      if (recentValues.some(v => v === null)) {
        console.log(`   [Trend] Null value found in last ${TREND_CONFIRMATION_PERIOD} periods`);
        return false;
      }
      const numValues = recentValues as number[];
      for (let i = 1; i < numValues.length; i++) {
        if (numValues[i] >= numValues[i-1]) return false;
      }
      return true;
    };

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
        emaMedium: latestEmaMedium?.toFixed(5) || 'N/A',
        emaLong: latestEmaLong?.toFixed(5) || 'N/A',
        pSar: latestPSar?.toFixed(5) || 'N/A',
        vwap: latestVwap?.toFixed(5) || 'N/A',
        rsi: latestRsi?.toFixed(2) || 'N/A',
        previousRsi: previousRsi?.toFixed(2) || 'N/A',
        lowerBB: latestLowerBB?.toFixed(5) || 'N/A',
        upperBB: latestUpperBB?.toFixed(5) || 'N/A',
        deepLowerBB: latestDeepLowerBB?.toFixed(5) || 'N/A',
        atr: latestAtr?.toFixed(5) || 'N/A',
        longTrend: isUptrend ? 'Uptrend' : 'Downtrend'
    });

    // Ensure all required indicator values are calculated
    const allIndicatorsAvailable = [
      latestEmaFast, latestEmaSlow, latestDeepLowerBB, latestEmaMedium,
      latestPSar, latestVwap, latestRsi, previousRsi, latestLowerBB, 
      latestUpperBB, latestAtr, latestEmaLong
    ].every(v => v !== null && v !== undefined);
    
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

    // Check volatility first
    if (latestAtr! < MIN_ATR_THRESHOLD) {
      console.log(`\n❌ Market too flat (ATR: ${latestAtr!.toFixed(5)} < ${MIN_ATR_THRESHOLD}). No signal generated.`);
      return NextResponse.json({ message: 'No signal generated due to low volatility.' });
    }

    const isLowVol = latestAtr! < LOW_VOL_THRESHOLD;

    // =================================================================
    // System 2: Momentum-Reversal (Enhanced Probability) - Check First
    // =================================================================
    console.log("\nEvaluating Enhanced Momentum-Reversal System:");

    // 1. DEEP OVERSOLD REVERSAL (High Confidence)
    console.log("\nChecking Deep Oversold Reversal (High Confidence):");
    const deepBuyC1 = latestRsi! <= DEEP_RSI_THRESHOLD;
    const deepBuyC2 = latestDataPoint.low <= latestDeepLowerBB!;
    const deepBuyC3 = (latestDataPoint.close - latestDataPoint.open) > MIN_CANDLE_BODY;
    const deepBuyC4 = latestDataPoint.volume > (previousDataPoint?.volume || 0) * VOLUME_SPIKE_FACTOR;
    const deepBuyC5 = latestDataPoint.close > latestPSar!;
    const deepBuyC6 = isUptrend;
    const isDeepBuySignal = deepBuyC1 && deepBuyC2 && deepBuyC3 && deepBuyC4 && deepBuyC5 && deepBuyC6;
    
    logCondition(`RSI <= ${DEEP_RSI_THRESHOLD}`, deepBuyC1, latestRsi!.toFixed(2));
    logCondition("Low <= Deep Lower BB", deepBuyC2, `${latestDataPoint.low.toFixed(5)} vs ${latestDeepLowerBB!.toFixed(5)}`);
    logCondition("Bullish Candle Body", deepBuyC3, `Size: ${(latestDataPoint.close - latestDataPoint.open).toFixed(5)}`);
    logCondition(`Volume > ${VOLUME_SPIKE_FACTOR}x Prev`, deepBuyC4, `${latestDataPoint.volume} vs ${previousDataPoint?.volume}`);
    logCondition("Price > PSAR", deepBuyC5, `${latestDataPoint.close.toFixed(5)} vs ${latestPSar!.toFixed(5)}`);
    logCondition("Uptrend Alignment", deepBuyC6, `Price:${latestDataPoint.close.toFixed(5)} > EMA(50):${latestEmaLong!.toFixed(5)}`);
    
    if (isDeepBuySignal) {
      newSignal = { type: 'BUY', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
      console.log('🔥 New HIGH-CONFIDENCE DEEP BUY signal generated.');
    } else {
      console.log("❌ Deep reversal conditions not fully met");
    }

    // 2. MODERATE REVERSAL BUY (Medium Confidence)
    if (!newSignal) {
      console.log("\nChecking Moderate Reversal Buy (Medium Confidence):");
      const modBuyC1 = previousRsi! < RSI_OVERSOLD_THRESHOLD;
      const modBuyC2 = latestRsi! > RSI_OVERSOLD_THRESHOLD;
      const modBuyC3 = latestDataPoint.low <= latestLowerBB!;
      const modBuyC4 = latestDataPoint.close > latestVwap!;
      const modBuyC5 = latestDataPoint.close > (latestLowerBB! * 1.001);
      const modBuyC6 = isUptrend;
      const isModerateBuySignal = modBuyC1 && modBuyC2 && modBuyC3 && modBuyC4 && modBuyC5 && modBuyC6;
      
      logCondition(`Prev RSI < ${RSI_OVERSOLD_THRESHOLD}`, modBuyC1, `${previousRsi!.toFixed(2)} < ${RSI_OVERSOLD_THRESHOLD}`);
      logCondition(`Curr RSI > ${RSI_OVERSOLD_THRESHOLD}`, modBuyC2, `${latestRsi!.toFixed(2)} > ${RSI_OVERSOLD_THRESHOLD}`);
      logCondition("Low <= LowerBB", modBuyC3, `${latestDataPoint.low.toFixed(5)} <= ${latestLowerBB!.toFixed(5)}`);
      logCondition("Price > VWAP", modBuyC4, `${latestDataPoint.close.toFixed(5)} > ${latestVwap!.toFixed(5)}`);
      logCondition("Close > LowerBB+0.1%", modBuyC5, `${latestDataPoint.close.toFixed(5)} > ${(latestLowerBB! * 1.001).toFixed(5)}`);
      logCondition("Uptrend Alignment", modBuyC6, `Price:${latestDataPoint.close.toFixed(5)} > EMA(50):${latestEmaLong!.toFixed(5)}`);
      
      if (isModerateBuySignal) {
        newSignal = { type: 'BUY', level: 'Medium', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New MEDIUM-CONFIDENCE BUY signal generated.');
      } else {
        console.log("❌ Moderate reversal conditions not fully met");
      }
    }

    // 3. REVERSAL SELL (Medium Confidence)
    if (!newSignal) {
      console.log("\nChecking Reversal Sell (Medium Confidence):");
      const revSellC1 = previousRsi! > RSI_OVERBOUGHT_THRESHOLD;
      const revSellC2 = latestRsi! < RSI_OVERBOUGHT_THRESHOLD;
      const revSellC3 = latestDataPoint.high >= latestUpperBB!;
      const revSellC4 = latestDataPoint.close < latestVwap!;
      const revSellC5 = latestDataPoint.close < (latestUpperBB! * 0.999);
      const revSellC6 = isDowntrend;
      const isReversalSellSignal = revSellC1 && revSellC2 && revSellC3 && revSellC4 && revSellC5 && revSellC6;
      
      logCondition("Prev RSI > Overbought", revSellC1, `${previousRsi!.toFixed(2)} > ${RSI_OVERBOUGHT_THRESHOLD}`);
      logCondition("Curr RSI < Overbought", revSellC2, `${latestRsi!.toFixed(2)} < ${RSI_OVERBOUGHT_THRESHOLD}`);
      logCondition("High >= UpperBB", revSellC3, `${latestDataPoint.high.toFixed(5)} >= ${latestUpperBB!.toFixed(5)}`);
      logCondition("Price < VWAP", revSellC4, `${latestDataPoint.close.toFixed(5)} < ${latestVwap!.toFixed(5)}`);
      logCondition("Close < UpperBB-0.1%", revSellC5, `${latestDataPoint.close.toFixed(5)} < ${(latestUpperBB! * 0.999).toFixed(5)}`);
      logCondition("Downtrend Alignment", revSellC6, `Price:${latestDataPoint.close.toFixed(5)} < EMA(50):${latestEmaLong!.toFixed(5)}`);
      
      if (isReversalSellSignal) {
        newSignal = { type: 'SELL', level: 'Medium', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New MEDIUM-CONFIDENCE SELL signal generated.');
      } else {
        console.log("❌ Reversal sell conditions not met");
      }
    }

    // =================================================================
    // System 1: Core Trend-Following (High Probability) - Check Last
    // =================================================================
    if (!newSignal) {
      console.log("\nEvaluating Core Trend-Following System (High):");

      // Trend confirmation checks
      const emaFastUp = isIncreasing(emaFast);
      const emaSlowUp = isIncreasing(emaSlow);
      const emaFastDown = isDecreasing(emaFast);
      const emaSlowDown = isDecreasing(emaSlow);
      
      // ====== NEW FILTERS ====== //
      // 1. Volume Confirmation
      const volumePeriods = 5;
      const volumeSum = chartData.slice(-volumePeriods).reduce((sum, d) => sum + d.volume, 0);
      const volumeAvg = volumeSum / volumePeriods;
      const volumeOK = latestDataPoint.volume > volumeAvg * VOLUME_CONFIRMATION_FACTOR;
      logCondition(`Volume > ${VOLUME_CONFIRMATION_FACTOR*100}% of avg`, volumeOK, 
                  `${latestDataPoint.volume} vs ${volumeAvg.toFixed(0)}`);
      
      // 2. Price Position Filter
      const bbWidth = latestUpperBB! - latestLowerBB!;
      const pricePosition = (latestDataPoint.close - latestLowerBB!) / bbWidth;
      const priceInMiddle = pricePosition > PRICE_POSITION_FILTER && 
                            pricePosition < (1 - PRICE_POSITION_FILTER);
      logCondition("Price in middle BB range", priceInMiddle, 
                  `Position: ${(pricePosition*100).toFixed(1)}%`);
      
      // 3. Dynamic PSAR Buffer
      const psarBuffer = latestAtr! * PSAR_BUFFER_FACTOR;
      logCondition("PSAR Buffer", true, `${psarBuffer.toFixed(5)} (${PSAR_BUFFER_FACTOR*100}% of ATR)`);
      // ========================= //

      // In low vol, simplify to basic EMA cross + RSI
      let coreBuyC1: boolean;
      if (isLowVol) {
        coreBuyC1 = latestEmaFast! > latestEmaSlow!;
        logCondition("Low Vol Mode: EMA(5) > EMA(13)", coreBuyC1, `${latestEmaFast!.toFixed(5)} vs ${latestEmaSlow!.toFixed(5)}`);
      } else {
        coreBuyC1 = latestEmaFast! > latestEmaSlow! && latestEmaSlow! > latestEmaMedium!;
        logCondition("EMA(5) > EMA(13) > EMA(20)", coreBuyC1, `${latestEmaFast!.toFixed(5)} vs ${latestEmaSlow!.toFixed(5)} vs ${latestEmaMedium!.toFixed(5)}`);
      }
      
      const coreBuyC2 = latestDataPoint.close > latestVwap!;
      const coreBuyC3 = latestDataPoint.close > (latestPSar! + psarBuffer); // Dynamic buffer
      const coreBuyC4 = latestRsi! < RSI_BUY_MAX; // Tightened RSI
      const coreBuyC5 = emaFastUp && emaSlowUp;
      const coreBuyC6 = isUptrend;
      const isCoreBuySignal = coreBuyC1 && coreBuyC2 && coreBuyC3 && coreBuyC4 && 
                             coreBuyC5 && coreBuyC6 && volumeOK && priceInMiddle; // Added filters
      
      logCondition("Price > VWAP", coreBuyC2, `${latestDataPoint.close.toFixed(5)} vs ${latestVwap!.toFixed(5)}`);
      logCondition("Price > PSAR + Buffer", coreBuyC3, `${latestDataPoint.close.toFixed(5)} vs ${(latestPSar! + psarBuffer).toFixed(5)}`);
      logCondition(`RSI < ${RSI_BUY_MAX}`, coreBuyC4, latestRsi!.toFixed(2));
      logCondition("EMA Trend Confirmed Up", coreBuyC5, `Last ${TREND_CONFIRMATION_PERIOD} periods`);
      logCondition("Uptrend Alignment", coreBuyC6, `Price:${latestDataPoint.close.toFixed(5)} > EMA(50):${latestEmaLong!.toFixed(5)}`);

      let coreSellC1: boolean;
      if (isLowVol) {
        coreSellC1 = latestEmaFast! < latestEmaSlow!;
        logCondition("Low Vol Mode: EMA(5) < EMA(13)", coreSellC1, `${latestEmaFast!.toFixed(5)} vs ${latestEmaSlow!.toFixed(5)}`);
      } else {
        coreSellC1 = latestEmaFast! < latestEmaSlow! && latestEmaSlow! < latestEmaMedium!;
        logCondition("EMA(5) < EMA(13) < EMA(20)", coreSellC1, `${latestEmaFast!.toFixed(5)} vs ${latestEmaSlow!.toFixed(5)} vs ${latestEmaMedium!.toFixed(5)}`);
      }
      
      const coreSellC2 = latestDataPoint.close < latestVwap!;
      const coreSellC3 = latestDataPoint.close < (latestPSar! - psarBuffer); // Dynamic buffer
      const coreSellC4 = latestRsi! > RSI_SELL_MIN; // Tightened RSI
      const coreSellC5 = emaFastDown && emaSlowDown;
      const coreSellC6 = isDowntrend;
      const isCoreSellSignal = coreSellC1 && coreSellC2 && coreSellC3 && coreSellC4 && 
                              coreSellC5 && coreSellC6 && volumeOK && priceInMiddle; // Added filters
      
      logCondition("Price < VWAP", coreSellC2, `${latestDataPoint.close.toFixed(5)} vs ${latestVwap!.toFixed(5)}`);
      logCondition("Price < PSAR - Buffer", coreSellC3, `${latestDataPoint.close.toFixed(5)} vs ${(latestPSar! - psarBuffer).toFixed(5)}`);
      logCondition(`RSI > ${RSI_SELL_MIN}`, coreSellC4, latestRsi!.toFixed(2));
      logCondition("EMA Trend Confirmed Down", coreSellC5, `Last ${TREND_CONFIRMATION_PERIOD} periods`);
      logCondition("Downtrend Alignment", coreSellC6, `Price:${latestDataPoint.close.toFixed(5)} < EMA(50):${latestEmaLong!.toFixed(5)}`);

      if (isCoreBuySignal) {
        newSignal = { type: 'BUY', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New HIGH-CONFIDENCE BUY signal generated.');
      } else if (isCoreSellSignal) {
        newSignal = { type: 'SELL', level: 'High', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New HIGH-CONFIDENCE SELL signal generated.');
      } else {
        console.log("❌ Core system: No signal. Conditions not all met.");
      }
    }

    // =================================================================
    // System 3: Momentum Shift (Low Probability) - Always log for debug
    // =================================================================
    console.log("\nEvaluating Momentum Shift System (Low):");
    const volumeUp = latestDataPoint.volume > (previousDataPoint?.volume || 0) * MIN_VOL_CHANGE;
    const shiftBuyC1 = previousRsi! < RSI_CENTERLINE;
    const shiftBuyC2 = latestRsi! > RSI_CENTERLINE;
    const shiftBuyC3 = volumeUp;
    const shiftBuyC4 = latestDataPoint.close > latestVwap!;
    const shiftBuyC5 = isUptrend;
    const isRsiBuyCross = shiftBuyC1 && shiftBuyC2 && shiftBuyC3 && shiftBuyC4 && shiftBuyC5;
    
    logCondition("Prev RSI < 50", shiftBuyC1, previousRsi!.toFixed(2));
    logCondition("Curr RSI > 50", shiftBuyC2, latestRsi!.toFixed(2));
    logCondition(`Volume > ${MIN_VOL_CHANGE}x Prev`, shiftBuyC3, `${latestDataPoint.volume} vs ${previousDataPoint?.volume}`);
    logCondition("Price > VWAP", shiftBuyC4, `${latestDataPoint.close.toFixed(5)} > ${latestVwap!.toFixed(5)}`);
    logCondition("Uptrend Alignment", shiftBuyC5, `Price:${latestDataPoint.close.toFixed(5)} > EMA(50):${latestEmaLong!.toFixed(5)}`);

    const shiftSellC1 = previousRsi! > RSI_CENTERLINE;
    const shiftSellC2 = latestRsi! < RSI_CENTERLINE;
    const shiftSellC3 = volumeUp;
    const shiftSellC4 = latestDataPoint.close < latestVwap!;
    const shiftSellC5 = isDowntrend;
    const isRsiSellCross = shiftSellC1 && shiftSellC2 && shiftSellC3 && shiftSellC4 && shiftSellC5;
    
    logCondition("Prev RSI > 50", shiftSellC1, previousRsi!.toFixed(2));
    logCondition("Curr RSI < 50", shiftSellC2, latestRsi!.toFixed(2));
    logCondition(`Volume > ${MIN_VOL_CHANGE}x Prev`, shiftSellC3, `${latestDataPoint.volume} vs ${previousDataPoint?.volume}`);
    logCondition("Price < VWAP", shiftSellC4, `${latestDataPoint.close.toFixed(5)} < ${latestVwap!.toFixed(5)}`);
    logCondition("Downtrend Alignment", shiftSellC5, `Price:${latestDataPoint.close.toFixed(5)} < EMA(50):${latestEmaLong!.toFixed(5)}`);

    if (!newSignal) {
      if (isRsiBuyCross) {
        newSignal = { type: 'BUY', level: 'Low', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New LOW-CONFIDENCE BUY signal generated.');
      } else if (isRsiSellCross) {
        newSignal = { type: 'SELL', level: 'Low', price: latestDataPoint.close, time: latestDataPoint.time };
        console.log('✅ New LOW-CONFIDENCE SELL signal generated.');
      } else {
        console.log("❌ Shift system: No signal.");
      }
    } else {
      console.log("Shift system checked for debug, but signal already generated from higher system.");
    }

    if (!newSignal) {
      console.log('\nNo new signal generated. Conditions not met for any system.');
      return NextResponse.json({ message: 'No new signal generated based on current strategy.' });
    }

    // Price Action Confirmation
    const confirmSignal = (signal: Signal) => {
      if (signal.type === 'BUY') {
        return latestDataPoint.close > prevCandle.high;
      } else {
        return latestDataPoint.close < prevCandle.low;
      }
    };

    if (!confirmSignal(newSignal as Signal)) {
      console.log(`\n❌ Signal invalidated by price action (failed to break ${newSignal.type === 'BUY' ? 'previous high' : 'previous low'})`);
      return NextResponse.json({ message: 'Unconfirmed signal discarded' });
    }

    // 4. Prevent Consecutive Duplicate Signals
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals.length > 0 ? lastSignals[0] : null;

    if (lastSignal) {
      console.log(`Last signal was '${lastSignal.type}' with '${lastSignal.level}' confidence. New signal is '${newSignal.type}' with '${newSignal.level}' confidence.`);
    } else {
      console.log('No previous signals found in history.');
    }

    if (lastSignal && newSignal.type === lastSignal.type && newSignal.level === lastSignal.level) {
      const message = `Skipping save. New signal '${newSignal.type} (${newSignal.level})' is identical to the last signal.`;
      console.log(`❌ ${message}`);
      return NextResponse.json({ message });
    }

    // 5. Save signal to Firestore
    if (newSignal) {
      await saveSignalToFirestore(newSignal);
      return NextResponse.json({ signal: newSignal });
    }
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: String(error) });
  }
}