'use server';

/**
 * @fileOverview A flow to analyze a Bybit API key for trading capabilities.
 *
 * - analyzeApiKey - Analyzes the API key and returns trading insights.
 * - AnalyzeApiKeyInput - The input type for the analyzeApiKey function.
 * - AnalyzeApiKeyOutput - The return type for the analyzeApiKey function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const AnalyzeApiKeyInputSchema = z.object({
  apiKey: z.string().describe('The Bybit API key.'),
  apiSecret: z.string().describe('The Bybit API secret.'),
});
export type AnalyzeApiKeyInput = z.infer<typeof AnalyzeApiKeyInputSchema>;

const AnalyzeApiKeyOutputSchema = z.object({
  canTrade: z.boolean().describe('Whether the API key has trading permissions.'),
  accountStatus: z.string().describe('The status of the Bybit account.'),
  availableCapabilities: z
    .string()
    .array()
    .describe('The available capabilities of the API key.'),
  missingCapabilities: z
    .string()
    .array()
    .describe('The missing capabilities of the API key that would be needed for full trading.'),
});
export type AnalyzeApiKeyOutput = z.infer<typeof AnalyzeApiKeyOutputSchema>;

export async function analyzeApiKey(input: AnalyzeApiKeyInput): Promise<AnalyzeApiKeyOutput> {
  return analyzeApiKeyFlow(input);
}

const bybitApiAccessChecker = ai.defineTool({
  name: 'checkBybitApiAccess',
  description: 'Checks Bybit API access and returns account status and permissions based on API documentation.',
  inputSchema: AnalyzeApiKeyInputSchema,
  outputSchema: z.object({
    canTrade: z.boolean().describe('Whether the API key has trading permissions.'),
    accountStatus: z.string().describe('The status of the Bybit account.'),
    availableCapabilities: z.string().array().describe('The available capabilities of the API key.'),
  }),
},
async input => {
  // TODO: Implement the actual API call to Bybit to check access.
  // This is a placeholder implementation.
  // Replace with actual Bybit API interaction.
  const canTrade = true; // Assume true for now
  const accountStatus = 'Active'; // Assume active for now
  const availableCapabilities = ['Spot Trading', 'Futures Trading', 'Margin Trading']; // Example capabilities

  return {
    canTrade,
    accountStatus,
    availableCapabilities,
  };
});

const analyzeApiKeyPrompt = ai.definePrompt({
  name: 'analyzeApiKeyPrompt',
  tools: [bybitApiAccessChecker],
  input: {schema: AnalyzeApiKeyInputSchema},
  output: {schema: AnalyzeApiKeyOutputSchema},
  prompt: `You are an expert Bybit API analyst.
  You will analyze the provided API key and secret to determine its trading capabilities.

  First, use the checkBybitApiAccess tool to get the account status and available capabilities.

  Based on the information from the tool and your knowledge of Bybit API documentation, determine if the API key has full trading permissions.
  If not, list the missing capabilities required for full trading.

  API Key: {{{apiKey}}}
  API Secret: {{{apiSecret}}}

  Return the analysis in the following JSON format:
  {
    "canTrade": true/false,
    "accountStatus": "Account status",
    "availableCapabilities": ["Capability1", "Capability2"],
    "missingCapabilities": ["MissingCapability1", "MissingCapability2"]
  }`,
});

const analyzeApiKeyFlow = ai.defineFlow(
  {
    name: 'analyzeApiKeyFlow',
    inputSchema: AnalyzeApiKeyInputSchema,
    outputSchema: AnalyzeApiKeyOutputSchema,
  },
  async input => {
    const {output} = await analyzeApiKeyPrompt(input);
    // Further logic can be added here to process the output if needed
    return output!;
  }
);
