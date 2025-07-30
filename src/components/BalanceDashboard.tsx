'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchWalletBalance, type BybitBalance } from '@/lib/bybit';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { RefreshCw, LogOut, AlertTriangle } from 'lucide-react';
import { useToast } from "@/hooks/use-toast"

interface BalanceDashboardProps {
  apiKey: string;
  apiSecret: string;
  onClearCredentials: () => void;
}

export function BalanceDashboard({ apiKey, apiSecret, onClearCredentials }: BalanceDashboardProps) {
  const [balance, setBalance] = useState<BybitBalance[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const getBalance = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetchWalletBalance(apiKey, apiSecret);
      if (response.retCode === 0) {
        setBalance(response.result.list);
      } else {
        const errorMessage = response.retMsg || 'An unknown error occurred.';
        setError(errorMessage);
        toast({
          variant: "destructive",
          title: "API Error",
          description: errorMessage,
        })
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to fetch balance.';
      setError(errorMessage);
       toast({
          variant: "destructive",
          title: "Error",
          description: errorMessage,
        })
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, apiSecret, toast]);

  useEffect(() => {
    getBalance();
  }, [getBalance]);

  return (
    <Card className="w-full shadow-lg">
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle>Unified Account Balance</CardTitle>
          <CardDescription>Your asset balances on the Bybit demo account.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={getBalance} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="destructive" size="icon" onClick={onClearCredentials}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && !isLoading && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Asset</TableHead>
              <TableHead className="text-right">Total Balance</TableHead>
              <TableHead className="text-right">Equity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-5 w-24 float-right" /></TableCell>
                  <TableCell className="text-right"><Skeleton className="h-5 w-24 float-right" /></TableCell>
                </TableRow>
              ))
            ) : balance && balance.length > 0 ? (
              balance.map((coin) => (
                <TableRow key={coin.coin}>
                  <TableCell className="font-medium flex items-center gap-2">
                     <span className="font-bold">{coin.coin}</span>
                  </TableCell>
                  <TableCell className="text-right">{parseFloat(coin.walletBalance).toFixed(6)}</TableCell>
                  <TableCell className="text-right">{parseFloat(coin.equity).toFixed(6)}</TableCell>
                </TableRow>
              ))
            ) : (
              !error && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center">
                    No assets found or balance is zero.
                  </TableCell>
                </TableRow>
              )
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
