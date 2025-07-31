'use client';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartDataPoint, Signal } from '@/lib/types';
import { useMemo } from 'react';

interface CryptoChartProps {
  data: ChartDataPoint[];
  signals: Signal[];
}

const chartConfig = {
  close: {
    label: 'Price',
    color: 'hsl(var(--primary))',
  },
  buy: {
    label: 'Buy Signal',
    color: 'hsl(var(--chart-2))',
  },
  sell: {
    label: 'Sell Signal',
    color: 'hsl(var(--chart-1))',
  },
};

export function CryptoChart({ data, signals }: CryptoChartProps) {
  const chartData = useMemo(() => {
    return data.map(d => ({
      ...d,
      time: new Date(d.time).toLocaleTimeString(),
    }));
  }, [data]);

  return (
    <ChartContainer config={chartConfig} className="min-h-[400px] w-full">
      <AreaChart
        data={chartData}
        margin={{
          top: 10,
          right: 30,
          left: 0,
          bottom: 0,
        }}
      >
        <defs>
          <linearGradient id="colorClose" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={chartConfig.close.color} stopOpacity={0.8} />
            <stop offset="95%" stopColor={chartConfig.close.color} stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="time" tickMargin={10} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
        <YAxis domain={['auto', 'auto']} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} tickFormatter={(value) => value.toFixed(5)} orientation="right" />
        <ChartTooltip
          cursor={{ stroke: 'hsl(var(--foreground))', strokeWidth: 1, strokeDasharray: '3 3' }}
          content={<ChartTooltipContent indicator="dot" />}
        />
        <Area
          type="monotone"
          dataKey="close"
          stroke={chartConfig.close.color}
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorClose)"
        />
        {signals.map((signal, index) => {
           const dataPoint = data.find(d => d.time === signal.time);
           if (!dataPoint) return null;
           const displayTime = new Date(dataPoint.time).toLocaleTimeString();
           return (
            <ReferenceDot
              key={index}
              x={displayTime}
              y={signal.price}
              r={8}
              fill={signal.type === 'BUY' ? chartConfig.buy.color : chartConfig.sell.color}
              stroke="hsl(var(--background))"
              strokeWidth={2}
              isFront={true}
            />
           )
        })}
      </AreaChart>
    </ChartContainer>
  );
}
