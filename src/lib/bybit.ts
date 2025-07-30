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
  const recvWindow = '10000'; // Bybit's default is 5000, but we can increase it
  const params = 'accountType=UNIFIED';
  
  // Correct signature generation for GET request
  // The string to sign is: timestamp + apiKey + recvWindow + queryString
  const toSign = timestamp + apiKey + recvWindow + params;
  const signature = await hmac_sha256(apiSecret, toSign);

  const headers = new Headers();
  headers.append('X-BAPI-API-KEY', apiKey);
  headers.append('X-BAPI-TIMESTAMP', timestamp);
  headers.append('X-BAPI-SIGN', signature);
  headers.append('X-BAPI-RECV-WINDOW', recvWindow);
  headers.append('Content-Type', 'application/json');

  const response = await fetch(`${host}${path}?${params}`, {
    method: 'GET',
    headers,
  });

  const responseData = await response.json();

  if (responseData.retCode !== 0) {
    // Provide a more detailed error message
    throw new Error(`Bybit API Error: ${responseData.retMsg} (retCode: ${responseData.retCode})`);
  }

  return responseData;
}
