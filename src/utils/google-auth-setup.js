#!/usr/bin/env node

/**
 * Google Ads OAuth2 Setup Helper
 *
 * Dit script helpt je om de benodigde OAuth2 refresh token
 * voor de Google Ads API te verkrijgen.
 */

import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(question) {
    return new Promise((resolve) => rl.question(question, resolve));
}

console.log(`
╔══════════════════════════════════════════════════════════╗
║       Google Ads API — OAuth2 Setup Helper              ║
╚══════════════════════════════════════════════════════════╝

Dit script helpt je om de Google Ads API credentials in te stellen.
Volg de stappen hieronder:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STAP 1: Google Ads Developer Token
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Ga naar https://ads.google.com/aw/apicenter
2. Vraag een developer token aan (of gebruik je bestaande)
3. Noteer de developer token

STAP 2: Google Cloud OAuth2 Client
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Ga naar https://console.cloud.google.com/apis/credentials
2. Maak een nieuw project aan (of gebruik bestaand)
3. Activeer de "Google Ads API" in de API Library
4. Ga naar "Credentials" → "Create Credentials" → "OAuth client ID"
5. Kies "Web application" als type
6. Voeg als Authorized redirect URI toe:
   → https://developers.google.com/oauthplayground
7. Noteer de Client ID en Client Secret

STAP 3: Refresh Token verkrijgen
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Ga naar https://developers.google.com/oauthplayground
2. Klik op het tandwiel ⚙️ (rechts bovenin)
3. Vink "Use your own OAuth credentials" aan
4. Vul je Client ID en Client Secret in
5. In "Step 1" voeg deze scope toe:
   → https://www.googleapis.com/auth/adwords
6. Klik "Authorize APIs" → log in → geef toestemming
7. In "Step 2" klik "Exchange authorization code for tokens"
8. Kopieer de "Refresh token"

STAP 4: Customer ID
━━━━━━━━━━━━━━━━━━━
1. Ga naar https://ads.google.com
2. Klik op je account → het 10-cijferige nummer (bijv. 123-456-7890)
3. Verwijder de streepjes → 1234567890

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

async function main() {
    const clientId = await ask('Voer je Google OAuth Client ID in: ');
    const clientSecret = await ask('Voer je Google OAuth Client Secret in: ');
    const developerToken = await ask('Voer je Google Ads Developer Token in: ');
    const customerId = await ask('Voer je Google Ads Customer ID in (zonder streepjes): ');
    const loginCustomerId = await ask('Voer je Manager Account ID in (optioneel, druk Enter om over te slaan): ');

    // Genereer de OAuth2 authorization URL
    const authUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(clientId)}&` +
        `redirect_uri=https://developers.google.com/oauthplayground&` +
        `response_type=code&` +
        `scope=https://www.googleapis.com/auth/adwords&` +
        `access_type=offline&` +
        `prompt=consent`;

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Je autorisatie-URL:
${authUrl}

Open deze URL in je browser, log in, en volg de stappen
op de OAuth Playground om je refresh token te verkrijgen.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

    const refreshToken = await ask('Voer je Refresh Token in: ');

    console.log(`
╔══════════════════════════════════════════════════════════╗
║  ✅ Voeg deze regels toe aan je .env bestand:           ║
╚══════════════════════════════════════════════════════════╝

GOOGLE_ADS_CLIENT_ID=${clientId}
GOOGLE_ADS_CLIENT_SECRET=${clientSecret}
GOOGLE_ADS_DEVELOPER_TOKEN=${developerToken}
GOOGLE_ADS_REFRESH_TOKEN=${refreshToken}
GOOGLE_ADS_CUSTOMER_ID=${customerId}
GOOGLE_ADS_LOGIN_CUSTOMER_ID=${loginCustomerId || customerId}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Klaar! Start de applicatie opnieuw om de nieuwe credentials
te laden: npm run dev
  `);

    rl.close();
}

main().catch(console.error);
