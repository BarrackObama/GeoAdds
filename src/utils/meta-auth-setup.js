#!/usr/bin/env node

/**
 * Meta Ads API Setup Helper
 *
 * Toont de stappen om de Meta/Facebook Ads API credentials te verkrijgen.
 */

console.log(`
╔══════════════════════════════════════════════════════════╗
║       Meta / Facebook Ads API — Setup Helper            ║
╚══════════════════════════════════════════════════════════╝

Volg deze stappen om de Meta Ads API in te stellen:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STAP 1: Meta App aanmaken
━━━━━━━━━━━━━━━━━━━━━━━━━
1. Ga naar https://developers.facebook.com/apps
2. Klik op "Create App" → "Business" → "Next"
3. Geef de app een naam (bijv. "Offgrid Storings-Ads")
4. Selecteer je Business Account
5. Noteer de App ID en het App Secret
   (te vinden onder Settings → Basic)

STAP 2: Marketing API toevoegen
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. In je app dashboard, klik op "Add Products"
2. Zoek "Marketing API" en klik "Set Up"
3. Configureer de permissions:
   - ads_management
   - ads_read
   - pages_read_engagement

STAP 3: Access Token genereren
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Ga naar https://developers.facebook.com/tools/explorer
2. Selecteer je app
3. Klik op "Generate Access Token"
4. Selecteer deze permissions:
   - ads_management
   - ads_read
   - pages_read_engagement
   - pages_manage_ads
5. Kopieer de access token

⚠️  BELANGRIJK: Dit is een kortstondige token (geldig ~2 uur).
Voor productie heb je een langdurige token nodig:

Langdurige token verkrijgen:
1. Open in je browser:
   https://graph.facebook.com/v21.0/oauth/access_token?
   grant_type=fb_exchange_token&
   client_id={APP_ID}&
   client_secret={APP_SECRET}&
   fb_exchange_token={KORTE_TOKEN}
2. Kopieer de access_token uit de response
3. Deze token is ~60 dagen geldig

STAP 4: Ad Account ID
━━━━━━━━━━━━━━━━━━━━━
1. Ga naar https://business.facebook.com/settings/ad-accounts
2. Klik op je advertentie-account
3. Kopieer het Account ID (lang nummer)
4. Voeg "act_" toe als prefix → act_123456789

STAP 5: Page ID
━━━━━━━━━━━━━━━
1. Ga naar je Facebook Pagina
2. Klik op "About" / "Over"
3. Scroll naar beneden voor de Page ID
4. OF gebruik de Graph API Explorer:
   GET /me/accounts → vind je pagina en kopieer het id

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Voeg de volgende regels toe aan je .env bestand:

META_APP_ID=jouw_app_id
META_APP_SECRET=jouw_app_secret
META_ACCESS_TOKEN=jouw_langdurige_access_token
META_AD_ACCOUNT_ID=act_jouw_account_id
META_PAGE_ID=jouw_page_id

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Start de applicatie opnieuw om de nieuwe credentials
te laden: npm run dev
`);
