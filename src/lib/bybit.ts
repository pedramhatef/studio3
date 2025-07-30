
export interface BybitBalance {
  coin: string;
  walletBalance: string;
  availableToWithdraw: string;
}

export interface BybitWalletResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: BybitBalance[];
  };
  time: number;
}

async function hmac_sha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await window.crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function fetchWalletBalance(apiKey: string, apiSecret: string): Promise<BybitWalletResponse> {
  const host = 'https://api-testnet.bybit.com';
  const path = '/v5/account/wallet-balance';
  const timestamp = Date.now().toString();
  const recvWindow = '10000';
  const params = 'accountType=UNIFIED';
  
  const toSign = timestamp + apiKey + recvWindow + params;
  const signature = await hmac_sha256(apiSecret, toSign);

  const headers = new Headers();
  headers.append('X-BAPI-API-KEY', apiKey);
  headers.append('X-BAPI-TIMESTAMP', timestamp);
  headers.append('X-BAPI-SIGN', signature);
  headers.append('X-BAPI-RECV-WINDOW', recvWindow);
  headers.append('Content-Type', 'application/json');
  
  const url = `${host}${path}?${params}`;

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  const responseText = await response.text();
  
  if (!response.ok) {
    throw new Error(`Bybit API request failed with status ${response.status}: ${responseText}`);
  }
  
  if (!responseText) {
    throw new Error('Bybit API returned an empty response.');
  }

  try {
    const responseData = JSON.parse(responseText);
    
    // Bybit API returns retCode 0 for success.
    if (responseData.retCode !== 0) {
      // Use a more descriptive error message from the API response if available.
      const errorMessage = responseData.retMsg || `Bybit API Error (retCode: ${responseData.retCode})`;
      throw new Error(errorMessage);
    }

    return responseData;
  } catch (error) {
    console.error("Failed to parse Bybit API response:", responseText);
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse JSON response. The API may have returned an HTML error page. Response: ${responseText}`);
    }
    // Re-throw other errors, including the custom one from above.
    throw error;
  }
}
