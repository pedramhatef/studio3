# **App Name**: Bybit Balance View

## Core Features:

- Fetch Balance: Fetch balance from Bybit demo account API using user-provided API key and secret (OLifq1rI7BrR4AOI0t and BFOwFXSQq5Q0dwVoGglefmfhqZ1kDMh4Cfk6)
- Balance Display: Display the fetched balance in a clear, readable format.
- Manual Refresh: Option to refresh the balance manually.
- Credentials persistence: Persist API key and secret in browser storage to be used automatically after a user's initial authentication.
- API setup page: Implement form to paste/modify the exchange API key/secret
- API Key Assessment: A 'trade insights' feature to analyze whether current API access allows for trading, using an LLM tool to check account status and permissions based on Bybit's API documentation and access rights conferred to the given user credentials, alerting users if full account capabilities have not yet been enabled or other capabilities are available

## Style Guidelines:

- Primary color: Deep blue (#3F51B5) to evoke trust and stability, reflecting the financial nature of the application.
- Background color: Very light blue (#F0F2F9), providing a clean and professional backdrop that ensures legibility.
- Accent color: Teal (#009688), used for interactive elements and highlights, to guide the user and provide visual interest.
- Body and headline font: 'Inter' (sans-serif), for a clean, modern, and highly readable user interface.
- Use minimalist icons to represent different currencies or account features.
- Maintain a clean and intuitive layout with clear sections for balance display and refresh options.