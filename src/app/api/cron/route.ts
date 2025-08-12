import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// TRADING STRATEGY CONFIGURATION
// =================================================================================

// System 1: Core Trend-Following (High Probability)
const EMA_FAST_PERIOD = 5; // Increased from 3 for less noise
const EMA_SLOW_PERIOD = 13; // Increased from 9 for smoother trend
const EMA_MEDIUM_PERIOD = 50; // Increased from 20 for stronger trend filter
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;

// System 2: Momentum-Reversal (Medium Probability)
const RSI_PERIOD = 14; // Increased from 7 for smoother RSI
const RSI_OVERSOLD_THRESHOLD = 30; // Loosened from 28 for more signals
const RSI_OVERBOUGHT_THRESHOLD = 70;
const DEEP_RSI_THRESHOLD = 25; // Loosened from 22 for more deep signals
const BBANDS_PERIOD = 20; // Increased from 12 for broader context
const BBANDS_STD_DEV = 1.5; // Increased from 1.2 for wider bands
const BBANDS_DEEP_MULTIPLIER = 2.0; // Widened from 1.8 for clearer deep levels
const VOLUME_SPIKE_FACTOR = 1.2; // Loosened from 1.3 for more triggers

// System 3: Momentum Shift (Low Probability)
const RSI_CENTERLINE = 50;

// Volatility & filters
const ATR_PERIOD = 14;
const MIN_ATR_THRESHOLD = 0.00025; // Skip signals in flat markets
const ATR_SPIKE_FACTOR = 2.0; // ATR > 2x rolling ATR => spike

// Weighted scoring (sA, sB, sC in [-1, +1])
const WEIGHT_A = 0.40; // Trend-Confirmation
const WEIGHT_B = 0.30; // Momentum/Oscillator
const WEIGHT_C = 0.30; // Volatility/Structure

// Combined thresholds
const THRESH_HIGH = 0.70;
const THRESH_MED = 0.40;
const THRESH_LOW = 0.15;

// Cooldown in minutes (cron runs every minute)
const COOLDOWN_MINUTES = { High: 3, Medium: 2, Low: 1 };

// Safety constants
const PSAR_FLIP_BARS = 3; // if PSAR flipped within last N bars, consider blocking/reducing score
const SMA_LONG_PERIOD = 200; // used for chop detection if available
const SMA_CHOP_PCT = 0.004; // 0.4% proximity considered chop near SMA

// =================================================================================
// Utility helpers
// =================================================================================
function clamp(v: number, a = -1, b = 1) {
  return Math.max(a, Math.min(b, v));
}
function isFiniteNumber(v: any): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function minutesBetween(ts1: number, ts2: number) {
  return Math.abs(ts1 - ts2) / 60000;
}

// short helper to check recent PSAR flip (we need PSAR array)
function psarFlippedWithinNbars(pSarArr: number[], n: number) {
  if (!Array.isArray(pSarArr) || pSarArr.length < n + 1) return false;
  // detect sign changes of (price - psar), approximate by psar direction change
  // We'll say flip happened if PSAR direction changed in last n bars by comparing adjacent values trend
  // This is approximate due to not having explicit PSAR trend direction from the lib.
  const last = pSarArr.length - 1;
  // If PSAR values moved from below price to above price or vice versa, caller should ensure price array available.
  // Here we approximate by changes in the psar delta over its own series.
  const d1 = pSarArr[last] - pSarArr[last - 1];
  for (let i = 1; i <= n; i++) {
    if ((pSarArr[last - i] - pSarArr[last - i - 1]) * d1 < 0) return true;
  }
  return false;
}

// normalize a value around an expected scale using logistic-ish clamp so extreme values don't dominate
function normalizeByScale(val: number, scale: number) {
  if (!isFiniteNumber(val) || !isFiniteNumber(scale) || scale === 0) return 0;
  // tanh-like normalization
  return Math.tanh(val / scale);
}

// =================================================================================
// GET handler — main cron entry
// =================================================================================
export async function GET() {
  console.log(`\n--- Cron job triggered at ${new Date().toISOString()} ---`);

  try {
    // 1. Fetch Latest Market Data
    const chartData = await getChartData();
    const minDataNeeded = Math.max(EMA_SLOW_PERIOD, BBANDS_PERIOD, RSI_PERIOD, ATR_PERIOD, SMA_LONG_PERIOD);
    if (!Array.isArray(chartData) || chartData.length < minDataNeeded + 5) {
      const message = 'Not enough data to calculate indicators.';
      console.log(message);
      return NextResponse.json({ message });
    }

    const closePrices = chartData.map(d => d.close);
    const highPrices = chartData.map(d => d.high);
    const lowPrices = chartData.map(d => d.low);
    const volumeArr = chartData.map(d => d.volume || 0);
    const latestIndex = chartData.length - 1;
    const latestDataPoint = chartData[latestIndex];
    const previousDataPoint = chartData[latestIndex - 1];

    // 2. Calculate All Necessary Indicators
    const emaFast = indicators.calculateEMA(closePrices, EMA_FAST_PERIOD);
    const emaSlow = indicators.calculateEMA(closePrices, EMA_SLOW_PERIOD);
    const emaMedium = indicators.calculateEMA(closePrices, EMA_MEDIUM_PERIOD);
    const pSar = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX); // returns array aligned with chartData
    const vwap = indicators.calculateVWAP(chartData); // assume array aligned
    const rsi = indicators.calculateRSI(closePrices, RSI_PERIOD);
    const bbands = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV);
    const deepBbands = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV * BBANDS_DEEP_MULTIPLIER);
    const atr = indicators.calculateATR(highPrices, lowPrices, closePrices, ATR_PERIOD);

    // optional SMA200 for chop detection — many libs expose SMA, if not available we'll skip chop check gracefully
    let sma200: number[];
    if (typeof indicators.calculateSMA === 'function') {
      try {
        sma200 = indicators.calculateSMA(closePrices, SMA_LONG_PERIOD).filter((v): v is number => v !== null);
      } catch (e) {
        sma200 = []; // Initialize with an empty array in case of error
      }
    } else {
      sma200 = []; // Initialize with an empty array if calculateSMA is not a function
    }
    

    // Get latest values (safe checks)
    const latestEmaFast = emaFast?.[emaFast.length - 1];
    const latestEmaSlow = emaSlow?.[emaSlow.length - 1];
    const latestEmaMedium = emaMedium?.[emaMedium.length - 1];
    const latestPSar = pSar?.[pSar.length - 1];
    const latestVwap = vwap?.[vwap.length - 1];
    const latestRsi = rsi?.[rsi.length - 1];
    const previousRsi = rsi?.[rsi.length - 2];
    const latestLowerBB = bbands?.lower?.[bbands.lower.length - 1];
    const latestUpperBB = bbands?.upper?.[bbands.upper.length - 1];
    const latestDeepLowerBB = deepBbands?.lower?.[deepBbands.lower.length - 1];
    const latestAtr = atr?.[atr.length - 1];
    const latestSma200 = sma200 ? sma200[sma200.length - 1] : null;
    const pSarRaw = indicators.calculateParabolicSAR(chartData, 0.02, 0.2);
    const sar = pSarRaw.filter((v): v is number => v !== null);


    // Some defensive logging
    console.log("Latest Data Point:", {
      price: latestDataPoint.close.toFixed(8),
      high: latestDataPoint.high.toFixed(8),
      low: latestDataPoint.low.toFixed(8),
      volume: latestDataPoint.volume,
      time: new Date(latestDataPoint.time).toLocaleString()
    });
    console.log("Indicators snapshot:", {
      emaFast: isFiniteNumber(latestEmaFast) ? latestEmaFast.toFixed(8) : 'N/A',
      emaSlow: isFiniteNumber(latestEmaSlow) ? latestEmaSlow.toFixed(8) : 'N/A',
      emaMedium: isFiniteNumber(latestEmaMedium) ? latestEmaMedium.toFixed(8) : 'N/A',
      vwap: isFiniteNumber(latestVwap) ? latestVwap.toFixed(8) : 'N/A',
      rsi: isFiniteNumber(latestRsi) ? latestRsi.toFixed(2) : 'N/A',
      lowerBB: isFiniteNumber(latestLowerBB) ? latestLowerBB.toFixed(8) : 'N/A',
      upperBB: isFiniteNumber(latestUpperBB) ? latestUpperBB.toFixed(8) : 'N/A',
      deepLowerBB: isFiniteNumber(latestDeepLowerBB) ? latestDeepLowerBB.toFixed(8) : 'N/A',
      atr: isFiniteNumber(latestAtr) ? latestAtr.toFixed(8) : 'N/A',
      sma200: isFiniteNumber(latestSma200) ? latestSma200.toFixed(8) : 'N/A',
      psar: isFiniteNumber(latestPSar) ? latestPSar.toFixed(8) : 'N/A'
    });

    // Ensure essential indicators are present
    const essentialAvailable = [latestEmaFast, latestEmaSlow, latestEmaMedium, latestPSar, latestVwap, latestRsi, previousRsi, latestLowerBB, latestUpperBB, latestDeepLowerBB, latestAtr]
      .every(isFiniteNumber);
    if (!essentialAvailable) {
      const message = 'Could not calculate all required indicator values.';
      console.log(message);
      return NextResponse.json({ message });
    }

    // Quick volatility filter
    if (latestAtr! < MIN_ATR_THRESHOLD) {
      console.log(`\n❌ Market too flat (ATR: ${latestAtr!.toFixed(8)} < ${MIN_ATR_THRESHOLD}). No signal generated.`);
      return NextResponse.json({ message: 'No signal generated due to low volatility.' });
    }

    // =================================================================================
    // Compute System Scores (sA, sB, sC)
    // sA = Trend-Confirmation; sB = Momentum/Oscillator; sC = Volatility/Structure
    // each in [-1, +1]
    // =================================================================================
    const price = latestDataPoint.close;
    const prevPrice = previousDataPoint.close;
    // sA: Trend confirmation
    let sA = 0;
    // bullish contributions
    if (latestEmaFast! > latestEmaSlow! && latestEmaSlow! > latestEmaMedium!) sA += 0.6;
    if (price > latestVwap!) sA += 0.25;
    if (price > latestPSar!) sA += 0.2;
    // momentum (rsi around 50-65 positive)
    sA += clamp((latestRsi! - 50) / 50) * 0.15;
    // bearish contributions
    if (latestEmaFast! < latestEmaSlow! && latestEmaSlow! < latestEmaMedium!) sA -= 0.6;
    if (price < latestVwap!) sA -= 0.25;
    if (price < latestPSar!) sA -= 0.2;
    sA = clamp(sA);

    // sB: Momentum & oscillator (RSI + MACD-like slope if available)
    // For MACD we don't have it guaranteed; use momentum proxy: price change & RSI delta & BB breakout
    let sB = 0;
    const rsiDelta = (latestRsi! - previousRsi!);
    // RSI moving up adds positive weight, down negative
    sB += clamp(rsiDelta / 10) * 0.6; // scale delta
    // price momentum (normalized by ATR)
    const priceMove = (price - prevPrice);
    sB += normalizeByScale(priceMove, latestAtr || 1) * 0.3;
    // BB breakout adds extra weight
    if (price > latestUpperBB!) sB += 0.15;
    if (price < latestLowerBB!) sB -= 0.15;
    // cap
    sB = clamp(sB);

    // sC: Volatility & structure (pullback acceptance or reversal/noise penalty)
    let sC = 0;
    // detect ATR spike vs historical mean ATR (rolling mean)
    const rollingAtrWindow = Math.min(50, atr.length - 1);
    let rollingMeanAtr = latestAtr!;
    if (rollingAtrWindow >= 5) {
      const start = Math.max(0, atr.length - 1 - rollingAtrWindow);
      const slice = atr.slice(start, atr.length - 1).filter(isFiniteNumber);
      if (slice.length > 0) {
        rollingMeanAtr = slice.reduce((a, b) => a + b, 0) / slice.length;
      }
    }
    const atrRatio = latestAtr! / Math.max(rollingMeanAtr, 1e-12);

    if (atrRatio > ATR_SPIKE_FACTOR) {
      // volatility spike -> penalize entries strongly
      sC -= 0.9;
    } else {
      // reward pullbacks to EMA or VWAP
      const distToEma21 = Math.abs(price - (latestEmaFast || 0));
      const distToEma50 = Math.abs(price - (latestEmaMedium || 0));
      const distToVwap = Math.abs(price - latestVwap!);
      // Use ATR to normalize
      const scorePullback = 0.0
        + (distToEma21 < 0.5 * latestAtr! ? 0.4 : 0)
        + (distToEma50 < 0.75 * latestAtr! ? 0.25 : 0)
        + (distToVwap < 0.75 * latestAtr! ? 0.2 : 0);
      sC += scorePullback;
      // penalty if price is outside deep BB (likely extended)
      if (price > latestUpperBB! && latestRsi! > 80) sC -= 0.5;
      if (price < latestLowerBB! && latestRsi! < 20) sC += 0.3; // deep oversold -> potential reversal support
    }

    
    // PSAR flip penalty
    if (psarFlippedWithinNbars(sar, PSAR_FLIP_BARS)) {
      sC -= 0.45;
    }
    sC = clamp(sC);

    const combinedRaw = clamp(WEIGHT_A * sA + WEIGHT_B * sB + WEIGHT_C * sC, -1, 1);
    console.log("System scores:", { sA: sA.toFixed(3), sB: sB.toFixed(3), sC: sC.toFixed(3), combinedRaw: combinedRaw.toFixed(3), atrRatio: atrRatio.toFixed(3) });

    // =================================================================================
    // Rule-based signal generation (kept from user's original logic) but validated
    // =================================================================================
    // We'll keep your original checks but convert them into a tentative newSignal, then validate with combined score and filters.
    let tentativeSignal: Omit<Signal, 'displayTime' | 'serverTime'> | null = null;

    // === System 2: Momentum-Reversal (Enhanced) — High/Medium checks ===
    // Deep Oversold Reversal (High Confidence)
    const deepBuyC1 = latestRsi! <= DEEP_RSI_THRESHOLD;
    const deepBuyC2 = latestDataPoint.low <= latestDeepLowerBB!;
    const deepBuyC3 = latestDataPoint.close > latestDataPoint.open;
    const deepBuyC4 = latestDataPoint.volume > (previousDataPoint?.volume || 0) * VOLUME_SPIKE_FACTOR;
    const deepBuyC5 = latestDataPoint.close > latestPSar!;
    const isDeepBuySignal = deepBuyC1 && deepBuyC2 && deepBuyC3 && deepBuyC4 && deepBuyC5;
    if (isDeepBuySignal) tentativeSignal = { type: 'BUY', level: 'High', price: price, time: latestDataPoint.time };

    // Moderate Reversal Buy (Medium)
    if (!tentativeSignal) {
      const modBuyC1 = previousRsi! < RSI_OVERSOLD_THRESHOLD;
      const modBuyC2 = latestRsi! > RSI_OVERSOLD_THRESHOLD;
      const modBuyC3 = latestDataPoint.low <= latestLowerBB!;
      const modBuyC4 = price > latestVwap!;
      const modBuyC5 = price > latestEmaSlow!;
      const isModerateBuySignal = modBuyC1 && modBuyC2 && modBuyC3 && modBuyC4 && modBuyC5;
      if (isModerateBuySignal) tentativeSignal = { type: 'BUY', level: 'Medium', price: price, time: latestDataPoint.time };
    }

    // Reversal Sell (Medium)
    if (!tentativeSignal) {
      const revSellC1 = previousRsi! > RSI_OVERBOUGHT_THRESHOLD;
      const revSellC2 = latestRsi! < RSI_OVERBOUGHT_THRESHOLD;
      const revSellC3 = latestDataPoint.high >= latestUpperBB!;
      const revSellC4 = price < latestVwap!;
      const revSellC5 = price < latestEmaSlow!;
      const isReversalSellSignal = revSellC1 && revSellC2 && revSellC3 && revSellC4 && revSellC5;
      if (isReversalSellSignal) tentativeSignal = { type: 'SELL', level: 'Medium', price: price, time: latestDataPoint.time };
    }

    // === System 1: Core Trend-Following (High) ===
    if (!tentativeSignal) {
      const coreBuyC1 = latestEmaFast! > latestEmaSlow! && latestEmaSlow! > latestEmaMedium!;
      const coreBuyC2 = price > latestVwap!;
      const coreBuyC3 = price > latestPSar!;
      const coreBuyC4 = latestRsi! < 55; // tightened
      const isCoreBuySignal = coreBuyC1 && coreBuyC2 && coreBuyC3 && coreBuyC4;

      const coreSellC1 = latestEmaFast! < latestEmaSlow! && latestEmaSlow! < latestEmaMedium!;
      const coreSellC2 = price < latestVwap!;
      const coreSellC3 = price < latestPSar!;
      const coreSellC4 = latestRsi! > 50; // tightened
      const isCoreSellSignal = coreSellC1 && coreSellC2 && coreSellC3 && coreSellC4;

      if (isCoreBuySignal) tentativeSignal = { type: 'BUY', level: 'High', price: price, time: latestDataPoint.time };
      else if (isCoreSellSignal) tentativeSignal = { type: 'SELL', level: 'High', price: price, time: latestDataPoint.time };
    }

    // === System 3: Momentum Shift (Low) ===
    if (!tentativeSignal) {
      const volumeUp = latestDataPoint.volume > (previousDataPoint?.volume || 0);
      const shiftBuyC1 = previousRsi! < RSI_CENTERLINE;
      const shiftBuyC2 = latestRsi! > RSI_CENTERLINE;
      const shiftBuyC3 = volumeUp;
      const shiftBuyC4 = price > latestVwap!;
      const isRsiBuyCross = shiftBuyC1 && shiftBuyC2 && shiftBuyC3 && shiftBuyC4;

      const shiftSellC1 = previousRsi! > RSI_CENTERLINE;
      const shiftSellC2 = latestRsi! < RSI_CENTERLINE;
      const shiftSellC3 = volumeUp;
      const shiftSellC4 = price < latestVwap!;
      const isRsiSellCross = shiftSellC1 && shiftSellC2 && shiftSellC3 && shiftSellC4;

      if (isRsiBuyCross) tentativeSignal = { type: 'BUY', level: 'Low', price: price, time: latestDataPoint.time };
      else if (isRsiSellCross) tentativeSignal = { type: 'SELL', level: 'Low', price: price, time: latestDataPoint.time };
    }

    // =================================================================================
    // Validation & enhancement by combined score and filters
    // - If we have a tentative rule-based signal, validate (or adjust its level) using combinedRaw
    // - If no tentativeSignal, possibly create one from combinedRaw thresholds
    // =================================================================================
    let newSignal: Omit<Signal, 'displayTime' | 'serverTime'> | null = null;

    // Helper: map combined score to side+level
    function mapScoreToSignal(score: number): Omit<Signal, 'displayTime' | 'serverTime'> | null {
      if (score >= THRESH_HIGH) return { type: 'BUY', level: 'High', price: price, time: latestDataPoint.time };
      if (score >= THRESH_MED) return { type: 'BUY', level: 'Medium', price: price, time: latestDataPoint.time };
      if (score >= THRESH_LOW) return { type: 'BUY', level: 'Low', price: price, time: latestDataPoint.time };
      if (score <= -THRESH_HIGH) return { type: 'SELL', level: 'High', price: price, time: latestDataPoint.time };
      if (score <= -THRESH_MED) return { type: 'SELL', level: 'Medium', price: price, time: latestDataPoint.time };
      if (score <= -THRESH_LOW) return { type: 'SELL', level: 'Low', price: price, time: latestDataPoint.time };
      return null;
    }

    // Hard filter: block if ATR spike large and combined score isn't extremely strong
    if (atrRatio > ATR_SPIKE_FACTOR && Math.abs(combinedRaw) < 0.85) {
      console.log(`❌ Blocking entries due to ATR spike (ratio ${atrRatio.toFixed(2)}) and combined score ${combinedRaw.toFixed(3)} < 0.85`);
      // still allow potential deep reversal high-confidence if rule-based deep oversold matched and combined strongly supports it
      if (!(isDeepBuySignal && combinedRaw > 0.85)) {
        // we will not emit a signal
        return NextResponse.json({ message: 'No signal: ATR spike / high volatility' });
      }
    }

    // Hard filter: chop zone near SMA200 if available
    if (latestSma200 && Math.abs(price - latestSma200) / latestSma200 < SMA_CHOP_PCT) {
      // In chop close to SMA200, require stronger combinedRaw to allow entries
      if (Math.abs(combinedRaw) < 0.6) {
        console.log(`⛔ In SMA200 chop zone (price within ${SMA_CHOP_PCT * 100}% of SMA200). Requiring stronger signal. combinedRaw=${combinedRaw.toFixed(3)}`);
        // allow deep reversal or very strong momentum that outruns the chop
        if (!(isDeepBuySignal && combinedRaw > 0.85)) {
          // don't proceed
          // But continue to final check — returning now to avoid saving
          return NextResponse.json({ message: 'No signal: SMA chop zone requires stronger confirmation.' });
        }
      }
    }

    // If there is a tentative rule-based signal, verify/adjust it with the combined score
    if (tentativeSignal) {
      const mapped = mapScoreToSignal(combinedRaw);

      // If the combined score contradicts the tentative (e.g., tentative BUY but mapped SELL), then block
      if (mapped && mapped.type !== tentativeSignal.type) {
        console.log(`❌ Tentative rule-based signal (${tentativeSignal.type} ${tentativeSignal.level}) conflicts with combined score mapping (${mapped.type}). Blocking.`);
        tentativeSignal = null;
      } else if (mapped) {
        // combine: pick the stronger of the two levels (rule-based or combined-based) by numeric mapping
        const rank = { Low: 1, Medium: 2, High: 3 };
        const tentativeRank = rank[tentativeSignal.level as keyof typeof rank] || 1;
        const mappedRank = rank[mapped.level as keyof typeof rank] || 1;
        const chosen = mappedRank > tentativeRank ? mapped : tentativeSignal;
        tentativeSignal = chosen;
        console.log(`🔧 Adjusted tentative signal using combined score => ${chosen.type} (${chosen.level}).`);
      } else {
        // no mapping (combinedRaw in neutral band) — allow tentative if it's Medium/High (but with caution)
        if (tentativeSignal.level === 'Low' && Math.abs(combinedRaw) < 0.1) {
          console.log('🔕 Tentative LOW signal but combined score neutral — drop to prevent noise.');
          tentativeSignal = null;
        } else {
          console.log('✅ Tentative signal kept despite neutral combined score (rule-based passed).');
        }
      }
    }

    // If no tentativeSignal now, try to create from combined score alone
    if (!tentativeSignal) {
      const mapped = mapScoreToSignal(combinedRaw);
      if (mapped) {
        tentativeSignal = mapped;
        console.log(`⚡ Combined-score-only generated signal: ${mapped.type} (${mapped.level}) from score ${combinedRaw.toFixed(3)}`);
      }
    }

    // Final safety: if PSAR flipped very recently and we are trading with same-direction PSAR suggests, block unless combinedRaw very strong
    if (tentativeSignal && psarFlippedWithinNbars(sar, PSAR_FLIP_BARS) && Math.abs(combinedRaw) < 0.8) {
      console.log('⛔ Blocking tentative signal because PSAR flipped recently and combined score < 0.8');
      tentativeSignal = null;
    }

    newSignal = tentativeSignal;

    if (!newSignal) {
      console.log('\nNo new signal generated after scoring and filters.');
      return NextResponse.json({ message: 'No new signal generated based on current strategy.' });
    }

    // 4. Prevent Consecutive Duplicate Signals & apply cooldowns
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals && lastSignals.length > 0 ? lastSignals[0] as Signal : null;

    if (lastSignal) {
      console.log(`Last signal: type='${lastSignal.type}', level='${lastSignal.level}', time=${new Date(lastSignal.time).toLocaleString()}, price=${lastSignal.price}`);
    } else {
      console.log('No previous signals found in history.');
    }

    // if identical to last signal, skip
    if (lastSignal && newSignal.type === lastSignal.type && newSignal.level === lastSignal.level) {
      const message = `Skipping save. New signal '${newSignal.type} (${newSignal.level})' is identical to the last signal.`;
      console.log(`❌ ${message}`);
      return NextResponse.json({ message });
    }

    // cooldown enforcement (minutes)
    if (lastSignal) {
      const cooldown = COOLDOWN_MINUTES[lastSignal.level as keyof typeof COOLDOWN_MINUTES] || 1;
      const minutesSinceLast = minutesBetween(new Date().getTime(), new Date(lastSignal.time).getTime());
      if (minutesSinceLast < cooldown) {
        console.log(`⏱️ Skipping save. Still in cooldown: ${minutesSinceLast.toFixed(2)}m since last (${cooldown}m cooldown for ${lastSignal.level}).`);
        return NextResponse.json({ message: 'Skipping due to cooldown.' });
      }
      // also require price movement since last signal to avoid duplicates; require at least 0.3*ATR move in same direction
      const priceMoveSinceLast = Math.abs(price - lastSignal.price);
      const requiredMove = 0.3 * (latestAtr || 1);
      if (newSignal.type === lastSignal.type && priceMoveSinceLast < requiredMove) {
        console.log(`⛔ Skipping save. Price hasn't moved enough since last signal (${priceMoveSinceLast.toFixed(8)} < ${requiredMove.toFixed(8)}).`);
        return NextResponse.json({ message: 'Skipping: insufficient price movement since last signal.' });
      }
    }

    // 5. Save signal to Firestore
    if (newSignal) {
      // Optionally augment with scoring metadata (server can accept extras; if not, remove)
      const toSave = {
        ...(newSignal as any),
        meta: {
          score: combinedRaw,
          sA,
          sB,
          sC,
          atrRatio,
        }
      } as any;

      await saveSignalToFirestore(toSave);
      console.log('✅ New signal saved:', toSave);
      return NextResponse.json({ signal: newSignal, score: combinedRaw });
    }

    // fallback
    return NextResponse.json({ message: 'No action taken.' });
  } catch (error) {
    console.error('Error in signal cron:', error);
    return NextResponse.json({ error: String(error) });
  }
}
