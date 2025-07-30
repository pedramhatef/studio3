'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { KeyRound, Lock } from 'lucide-react';

const formSchema = z.object({
  apiKey: z.string().min(1, { message: 'API Key is required.' }),
  apiSecret: z.string().min(1, { message: 'API Secret is required.' }),
});

interface SetupFormProps {
  onCredentialsSave: (apiKey: string, apiSecret: string) => void;
}

export function SetupForm({ onCredentialsSave }: SetupFormProps) {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      apiKey: '3SZRXse7O18TcsS868',
      apiSecret: 'm6Cc9H0eX5PjIb9eWViXSUZZJSk37mwNQrKU',
    },
  });

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
            <CardFooter className="flex justify-end">
              <Button type="submit">Save & Connect</Button>
            </CardFooter>
          </form>
        </Form>
      </Card>
    </div>
  );
}
