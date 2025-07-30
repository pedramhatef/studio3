'use client';

import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { analyzeApiKey } from '@/ai/flows/analyze-api-key';
import type { AnalyzeApiKeyOutput } from '@/ai/flows/analyze-api-key';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Loader2, Lightbulb, AlertTriangle, KeyRound, Lock } from 'lucide-react';
import { Skeleton } from './ui/skeleton';
import { useToast } from "@/hooks/use-toast"

const formSchema = z.object({
  apiKey: z.string().min(1, { message: 'API Key is required.' }),
  apiSecret: z.string().min(1, { message: 'API Secret is required.' }),
});

interface SetupFormProps {
  onCredentialsSave: (apiKey: string, apiSecret: string) => void;
}

export function SetupForm({ onCredentialsSave }: SetupFormProps) {
  const [isPending, startTransition] = useTransition();
  const [insights, setInsights] = useState<AnalyzeApiKeyOutput | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const { toast } = useToast();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      apiKey: '3SZRXse7O18TcsS868',
      apiSecret: 'm6Cc9H0eX5PjIb9eWViXSUZZJSk37mwNQrKU',
    },
  });

  const handleAnalyzeKey = async () => {
    const { apiKey, apiSecret } = form.getValues();
    if (!apiKey || !apiSecret) {
      toast({
        variant: "destructive",
        title: "Missing Credentials",
        description: "Please enter both API Key and Secret to analyze."
      });
      return;
    }

    setInsights(null);
    setInsightsError(null);

    startTransition(async () => {
      try {
        const result = await analyzeApiKey({ apiKey, apiSecret });
        setInsights(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
        setInsightsError(errorMessage);
      }
    });
  };

  function onSubmit(values: z.infer<typeof formSchema>) {
    onCredentialsSave(values.apiKey, values.apiSecret);
  }

  return (
    <div className="w-full space-y-6">
      <Card className="w-full shadow-lg">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <CardHeader>
              <CardTitle>Connect to Bybit</CardTitle>
              <CardDescription>
                Enter your Bybit demo account API credentials to view your balance. Your keys are stored securely in your browser.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="apiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Key</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input placeholder="Your API Key" {...field} className="pl-10" />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="apiSecret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Secret</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input type="password" placeholder="Your API Secret" {...field} className="pl-10" />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
            <CardFooter className="flex justify-between">
              <Button type="button" variant="outline" onClick={handleAnalyzeKey} disabled={isPending}>
                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lightbulb className="mr-2 h-4 w-4" />}
                Get Trade Insights
              </Button>
              <Button type="submit">Save & Connect</Button>
            </CardFooter>
          </form>
        </Form>
      </Card>
      
      {(isPending || insights || insightsError) && (
        <Card className="w-full shadow-lg animate-in fade-in-0 zoom-in-95">
          <CardHeader>
            <CardTitle>API Key Assessment</CardTitle>
            <CardDescription>Analysis of your API key permissions and capabilities.</CardDescription>
          </CardHeader>
          <CardContent>
            {isPending && (
              <div className="space-y-4">
                <Skeleton className="h-6 w-1/3" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              </div>
            )}
            {insightsError && !isPending && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Analysis Failed</AlertTitle>
                <AlertDescription>{insightsError}</AlertDescription>
              </Alert>
            )}
            {insights && !isPending && (
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <h3 className="font-semibold">Trading Status:</h3>
                  <Badge variant={insights.canTrade ? 'default' : 'destructive'} className="bg-green-600 dark:bg-green-700 text-primary-foreground">
                    {insights.canTrade ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                <div className="flex items-center gap-4">
                  <h3 className="font-semibold">Account Status:</h3>
                  <Badge variant="secondary">{insights.accountStatus}</Badge>
                </div>
                <div>
                  <h3 className="font-semibold mb-2">Available Capabilities:</h3>
                  <div className="flex flex-wrap gap-2">
                    {insights.availableCapabilities.map(cap => <Badge key={cap} variant="outline">{cap}</Badge>)}
                  </div>
                </div>
                {insights.missingCapabilities.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-2">Missing Capabilities for Full Trading:</h3>
                    <div className="flex flex-wrap gap-2">
                      {insights.missingCapabilities.map(cap => <Badge key={cap} variant="destructive">{cap}</Badge>)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
