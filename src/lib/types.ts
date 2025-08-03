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
}
