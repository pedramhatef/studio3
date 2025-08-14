export interface ChartDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  type: 'BUY' | 'SELL';
  level: 'High' | 'Medium' | 'Low';
  price: number;
  time: number;
  displayTime?: string;
  serverTime?: any;
}

export type StrategyParams = {
    // Core Trend-Following
    EMA_FAST_PERIOD: number;
    EMA_SLOW_PERIOD: number;
    EMA_LONG_PERIOD: number;
    PARABOLIC_SAR_STEP: number;
    PARABOLIC_SAR_MAX: number;
  
    // Momentum
    RSI_PERIOD: number;
    RSI_OVERSOLD_THRESHOLD: number;
    RSI_OVERBOUGHT_THRESHOLD: number;
  
    // Volatility Filter
    ATR_PERIOD: number;
    ATR_VOLATILITY_THRESHOLD: number;
    
    // Backtesting Simulation
    TAKE_PROFIT_ATR_MULTIPLIER: number;
    STOP_LOSS_ATR_MULTIPLIER: number;
};
