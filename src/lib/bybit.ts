
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
  
  const url = `${host}${path}?${params}`;

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Bybit API request failed with status ${response.status}: ${responseText}`);
  }
  
  // Bybit can return an HTML error page even with a 200 OK status on error.
  // We check if the response is valid JSON before parsing.
  try {
    const responseData = JSON.parse(responseText);
    
    if (responseData.retCode !== 0) {
      // This is an expected API error from Bybit, with a message.
      throw new Error(`Bybit API Error: ${responseData.retMsg} (retCode: ${responseData.retCode})`);
    }

    return responseData;
  } catch (error) {
    // This catches JSON parsing errors, which happen on unexpected server responses.
    console.error("Failed to parse Bybit API response:", responseText);
    throw new Error(`Failed to parse Bybit API response. The server sent back an unexpected response.`);
  }
}
