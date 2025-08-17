import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams } from '@/lib/types';
import * as indicators from '@/lib/indicators'; 

interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

const DEBUG = true;
const COOLDOWN_HIGH = 3 * 60 * 1000; // 3 minutes in ms
const COOLDOWN_MEDIUM = 5 * 60 * 1000; // 5 minutes in ms

export const revalidate = 0;

function log(message: string, ...args: any[]) {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [info] ${message}`, ...args);
  }
}
function section(title: string) {
  log(`=== ${title} ===`);
}
function kv(obj: Record<string, any>) {
  log(JSON.stringify(obj, null, 2));
}
function logCond(name: string, passed: boolean, details?: string) {
  log(`${passed ? '✔' : '✘'} ${name}${details ? ` → ${details}` : ''}`);
}

export async function GET() {
  const ts = new Date().toISOString();
  let strategyConfig: StrategyParams;

  section('Fetch Optimal Parameters');
  try {
    const latestParams = await getLatestOptimizationParams();
    if (latestParams) {
        strategyConfig = { ...latestParams, SPREAD_PERCENT: 0.01 } as StrategyParams;
        log('Applied optimal parameters from Firestore.');
        kv(strategyConfig);
    } else {
        log('No optimization results found in Firestore. Cannot proceed without a strategy.');
        return NextResponse.json({ message: 'No strategy parameters available from optimization.' }, { status: 500 });
    }
  } catch (error) {
    console.error(`Error fetching optimization results:`, error);
    log('Cannot proceed without a strategy due to fetch error.');
    return NextResponse.json({ message: 'Failed to fetch strategy parameters.' }, { status: 500 });
  }

  section(`CRON RUN @ ${ts}`);

  try {
    const requiredPeriods = Math.max(
      strategyConfig.EMA_SLOW_PERIOD, 
      strategyConfig.RSI_PERIOD, 
      strategyConfig.ATR_PERIOD, 
      strategyConfig.VOLUME_PERIOD
    ) + 2;

    const dogeChartData = await getChartData('DOGEUSDT');

    if (!Array.isArray(dogeChartData) || dogeChartData.length < requiredPeriods) { 
      log(`Not enough data. DOGE=${dogeChartData?.length ?? 0} Need>=${requiredPeriods}`);
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }
    
    const recentSignals = await getSignalHistoryFromFirestore();
    const lastSignal = recentSignals?.[0] ?? null;

    if (lastSignal) {
        const lastSignalTime = lastSignal.time;
        const latestCandleTime = dogeChartData[dogeChartData.length - 1].time;
        const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
        const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
        
        if (timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown) { 
            log(`In active trade cooldown (${cooldown/60000} mins). No new signals will be generated.`);
            return NextResponse.json({ message: 'In active trade cooldown. No new signal generated.' });
        }
    }

    section('Find New Signal');
    const dogeClose = dogeChartData.map(d => d.close);
    const dogeVolume = dogeChartData.map(d => d.volume);

    const emaFastArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_SLOW_PERIOD);
    const rsiArr = indicators.calculateRSI(dogeClose, strategyConfig.RSI_PERIOD);
    const atrArr = indicators.calculateATR(dogeChartData, strategyConfig.ATR_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(dogeChartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
    const volumeSma = indicators.calculateSMA(dogeVolume, strategyConfig.VOLUME_PERIOD);
    
    const i = dogeChartData.length - 1; 
    const prev_i = i - 1; 
    const prev_prev_i = prev_i - 1;

    const latest = dogeChartData[i];
    const prevCandle = dogeChartData[prev_i];

    log('Evaluating signal on previous candle:', {
      time: new Date(prevCandle.time).toISOString(),
      close: Number(prevCandle.close).toFixed(6),
    });

    const emaFastPrev = indicators.getValueAt(emaFastArr, prev_prev_i);
    const emaSlowPrev = indicators.getValueAt(emaSlowArr, prev_prev_i);
    const emaFastCurr = indicators.getValueAt(emaFastArr, prev_i);
    const emaSlowCurr = indicators.getValueAt(emaSlowArr, prev_i);
    const rsiCurr = indicators.getValueAt(rsiArr, prev_i);
    const psarCurr = indicators.getValueAt(psarArr, prev_i);
    const volumeCurr = indicators.getValueAt(dogeVolume, prev_i);
    const avgVolumeCurr = indicators.getValueAt(volumeSma, prev_i);
    const atrCurr = indicators.getValueAt(atrArr, i); // Current ATR for SL/TP

    if ([emaFastPrev, emaSlowPrev, emaFastCurr, emaSlowCurr, rsiCurr, psarCurr, volumeCurr, avgVolumeCurr, atrCurr].some(v => v === null)) {
      log('Indicator calculation incomplete on previous candle:', { 
        emaFastPrev, emaSlowPrev, emaFastCurr, emaSlowCurr, 
        rsiCurr, psarCurr, volumeCurr, avgVolumeCurr, atrCurr 
      });
      return NextResponse.json({ message: 'Incomplete indicator data.' });
    }

    const volumeConfirmed = volumeCurr! > avgVolumeCurr! * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER * 0.85;
    logCond('Volume Confirmation Base', volumeConfirmed, `Vol ${volumeCurr!.toFixed(2)} > AvgVol ${avgVolumeCurr!.toFixed(2)} * ${strategyConfig.VOLUME_THRESHOLD_MULTIPLIER} "* 0.85"`);

    const volumeRatio = volumeCurr! / avgVolumeCurr!;
    const volumeConfirmation = volumeRatio > strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation;
    logCond('Volume Confirmation Medium', volumeConfirmation, `Vol ${volumeRatio!.toFixed(2)} > Medium Threshold ${strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation}`);

 
    let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;
    let signalType: Signal['type'] | null = null;
    let confidence: Signal['level'] | null = null;

    
    
    // High-confidence Crossover Logic
    const emaCrossedUp = emaFastPrev! <= emaSlowPrev! && emaFastCurr! > emaSlowCurr!;
    const emaCrossedDown = emaFastPrev! >= emaSlowPrev! && emaFastCurr! < emaSlowCurr!;
    const rsiInRangeBuy = rsiCurr! < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
    const rsiInRangeSell = rsiCurr! > strategyConfig.RSI_OVERSOLD_THRESHOLD;
    const psarConfirmBuy = psarCurr! < prevCandle.close;
    const psarConfirmSell = psarCurr! > prevCandle.close;

    logCond('EMA Crossover Up', emaCrossedUp, `Fast: ${emaFastPrev!.toFixed(5)}->${emaFastCurr!.toFixed(5)} | Slow: ${emaSlowPrev!.toFixed(5)}->${emaSlowCurr!.toFixed(5)}`);
    logCond('EMA Crossover Down', emaCrossedDown, `Fast: ${emaFastPrev!.toFixed(5)}->${emaFastCurr!.toFixed(5)} | Slow: ${emaSlowPrev!.toFixed(5)}->${emaSlowCurr!.toFixed(5)}`);
    logCond('RSI Buy Range', rsiInRangeBuy, `RSI: ${rsiCurr!.toFixed(2)} < ${strategyConfig.RSI_OVERBOUGHT_THRESHOLD}`);
    logCond('RSI Sell Range', rsiInRangeSell, `RSI: ${rsiCurr!.toFixed(2)} > ${strategyConfig.RSI_OVERSOLD_THRESHOLD}`);
    logCond('PSAR Buy Confirmation', psarConfirmBuy, `PSAR: ${psarCurr!.toFixed(5)} < Close: ${prevCandle.close}`);
    logCond('PSAR Sell Confirmation', psarConfirmSell, `PSAR: ${psarCurr!.toFixed(5)} > Close: ${prevCandle.close}`);

    
    
    
    if (volumeConfirmed) {
        // High-confidence signals
        if (emaCrossedUp && rsiInRangeBuy && psarConfirmBuy) {
            signalType = 'BUY';
            confidence = 'High';
        } else if (emaCrossedDown && rsiInRangeSell && psarConfirmSell) {
            signalType = 'SELL';
            confidence = 'High';
        }



        // Medium-confidence Pullback signals
        if (!signalType) {
            const isPullbackBuy = prevCandle.low <= emaFastCurr! && prevCandle.close > emaFastCurr!;
            const rsiPullbackOkBuy = rsiCurr! > 40 && rsiInRangeBuy;
            logCond('Pullback Buy', isPullbackBuy, `Low: ${prevCandle.low.toFixed(5)} <= EMA Fast: ${emaFastCurr!.toFixed(5)} & Close: ${prevCandle.close.toFixed(5)} > EMA Fast`);
            logCond('RSI Pullback Buy', rsiPullbackOkBuy, `RSI: ${rsiCurr!.toFixed(2)} > 40`);

            if (isPullbackBuy && rsiPullbackOkBuy && psarConfirmBuy) {
                signalType = 'BUY';
                confidence = 'Medium';
            } else {
                const isPullbackSell = prevCandle.high >= emaFastCurr! && prevCandle.close < emaFastCurr!;
                const rsiPullbackOkSell = rsiCurr! < 60 && rsiInRangeSell;
                logCond('Pullback Sell', isPullbackSell, `High: ${prevCandle.high.toFixed(5)} >= EMA Fast: ${emaFastCurr!.toFixed(5)} & Close: ${prevCandle.close.toFixed(5)} < EMA Fast`);
                logCond('RSI Pullback Sell', rsiPullbackOkSell, `RSI: ${rsiCurr!.toFixed(2)} < 60`);

                if (isPullbackSell && rsiPullbackOkSell && psarConfirmSell) {
                    signalType = 'SELL';
                    confidence = 'Medium';
                }
            }
        }


        if (!volumeConfirmation) {
          logCond('Volume Confirmation Medium', volumeConfirmation, `Vol ${volumeRatio!.toFixed(2)} > Medium Threshold ${strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation}`);
          signalType = null;
          confidence = null;
      } 
      // Additional medium confidence filter
      else if (confidence === 'Medium' && volumeRatio < 1.8) {
          logCond('Volume Confirmation Medium', volumeConfirmation, `Vol ${volumeRatio!.toFixed(2)} < 1.8`);
          signalType = null;
          confidence = null;
 } else if (signalType && confidence) {
 log('Volume Confirmation passed:', {
 volumeRatio: volumeRatio.toFixed(2),
 threshold: strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation,
 });
      }
      

        if (signalType && confidence) {
          // --- START OF NEW FILTER ---
          // Get current ATR value
          const atrCurr = indicators.getValueAt(atrArr, i);
          if (atrCurr === null) {
              logCond('ATR Value Check', false, 'ATR value not available for current candle');
              signalType = null;
              confidence = null;
          } else {
 logCond('ATR Filter Evaluation', true, 'Evaluating filter');
 kv({
                currentATR: atrCurr.toFixed(6),
                requiredMinMovement: (atrCurr * 0.7).toFixed(6),
              });
              const minPriceMovement = atrCurr * 0.7; // Require min 70% of ATR
              const priceChange = Math.abs(latest.open - prevCandle.close);

              if (priceChange < minPriceMovement) {
 logCond('ATR Filter', false, `Price change ${priceChange.toFixed(6)} < min required ${minPriceMovement.toFixed(6)} (ATR: ${atrCurr.toFixed(6)})`);
                signalType = null;
                confidence = null;
              } else {
 logCond('ATR Filter', true, `Price change ${priceChange.toFixed(6)} >= min required ${minPriceMovement.toFixed(6)}`);
              }
        }
        // --- END OF NEW FILTER ---

        const isBullishConfirmation = (
          latest.close > latest.open && 
          latest.close > prevCandle.high
      );
      
      const isBearishConfirmation = (
          latest.close < latest.open && 
          latest.close < prevCandle.low
      );
      
      if (signalType === 'BUY' && !isBullishConfirmation) {
          log("Buy signal rejected: Missing bullish confirmation(ATR)");
          signalType = null;
      } else if (signalType === 'SELL' && !isBearishConfirmation) {
          log("Sell signal rejected: Missing bearish confirmation(ATR)");
          signalType = null;
      }
    }

    

        if (signalType && confidence) {
            signal = { 
                type: signalType, 
                level: confidence, 
                price: latest.open, 
                time: latest.time 
            };

            // Calculate leverage and stop buffer
            const capital = 1000; 
            const dollarRisk = capital * (atrCurr! > 0.0005 ? 0.0075 : 0.0125);
            const positionSize = dollarRisk / (atrCurr! * strategyConfig.STOP_LOSS_ATR_MULTIPLIER);
            const leverage = Math.min(10, Math.max(1, Math.round((positionSize * latest.open) / capital)));
            
            
            signal.suggestedLeverage = leverage;
            signal.stopBuffer = atrCurr! * strategyConfig.STOP_LOSS_ATR_MULTIPLIER;
        }
    }

    if (!signal) {
        log('No signal generated based on entry conditions.');
        return NextResponse.json({ message: 'No signal generated.' });
    }
    
    await saveSignalToFirestore(signal);
    log('✓ Signal saved:', signal);
    return NextResponse.json({ signal });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log(`Error: ${errorMessage}`, errorStack ? `\nStack: ${errorStack}`: '');
    return NextResponse.json({ error: errorMessage });
  }
}