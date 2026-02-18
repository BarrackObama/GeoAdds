#!/usr/bin/env node

/**
 * Test Connections — Test alle externe connecties
 *
 * Controleert of de credentials juist zijn geconfigureerd en
 * of er verbinding gemaakt kan worden met de externe services.
 */

import 'dotenv/config';
import axios from 'axios';

const PASS = '✅';
const FAIL = '❌';
const SKIP = '⏭️ ';

async function testOutageApi() {
    const mode = process.env.DATA_SOURCE_MODE || 'scrape';
    console.log(`\n📡 Storingsdata (modus: ${mode})`);
    console.log('─'.repeat(40));

    if (mode === 'api' || mode === 'hybrid') {
        const clientId = process.env.OUTAGE_API_CLIENT_ID;
        const clientSecret = process.env.OUTAGE_API_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            console.log(`${FAIL} OUTAGE_API_CLIENT_ID/SECRET niet geconfigureerd`);
            return;
        }

        try {
            const authUrl = process.env.OUTAGE_AUTH_URL || 'https://energieonderbrekingen.eu.auth0.com/oauth/token';
            const response = await axios.post(authUrl, {
                client_id: clientId,
                client_secret: clientSecret,
                audience: process.env.OUTAGE_API_AUDIENCE || 'https://energieonderbrekingen.nl/api/v2',
                grant_type: 'client_credentials',
            }, { timeout: 10000 });

            if (response.data.access_token) {
                console.log(`${PASS} Auth0 token succesvol verkregen`);
                console.log(`   Token geldig voor: ${Math.round((response.data.expires_in || 0) / 3600)} uur`);

                // Test de API endpoint
                try {
                    const apiResponse = await axios.get(
                        'https://energieonderbrekingen.nl/api/v2/disruptions',
                        {
                            headers: { Authorization: `Bearer ${response.data.access_token}` },
                            timeout: 10000,
                        }
                    );
                    console.log(`${PASS} API endpoint bereikbaar (status: ${apiResponse.status})`);
                } catch (apiError) {
                    console.log(`${FAIL} API endpoint fout: ${apiError.message}`);
                }
            }
        } catch (error) {
            console.log(`${FAIL} Auth0 authenticatie mislukt: ${error.message}`);
        }
    }

    if (mode === 'scrape' || mode === 'hybrid') {
        try {
            const response = await axios.get('https://energieonderbrekingen.nl', {
                timeout: 10000,
                validateStatus: () => true,
            });
            console.log(`${PASS} energieonderbrekingen.nl bereikbaar (status: ${response.status})`);
        } catch (error) {
            console.log(`${FAIL} energieonderbrekingen.nl niet bereikbaar: ${error.message}`);
        }

        try {
            await import('playwright');
            console.log(`${PASS} Playwright is geïnstalleerd`);
        } catch {
            console.log(`${FAIL} Playwright is NIET geïnstalleerd. Run: npx playwright install chromium`);
        }
    }
}

async function testGoogleAds() {
    console.log('\n🔍 Google Ads API');
    console.log('─'.repeat(40));

    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;

    if (!clientId) return console.log(`${SKIP} GOOGLE_ADS_CLIENT_ID niet ingesteld`);
    if (!clientSecret) return console.log(`${SKIP} GOOGLE_ADS_CLIENT_SECRET niet ingesteld`);
    if (!developerToken) return console.log(`${SKIP} GOOGLE_ADS_DEVELOPER_TOKEN niet ingesteld`);
    if (!refreshToken) return console.log(`${SKIP} GOOGLE_ADS_REFRESH_TOKEN niet ingesteld`);
    if (!customerId) return console.log(`${SKIP} GOOGLE_ADS_CUSTOMER_ID niet ingesteld`);

    console.log(`${PASS} Alle credentials aanwezig`);

    try {
        // Test OAuth2 token refresh
        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }, { timeout: 10000 });

        if (tokenResponse.data.access_token) {
            console.log(`${PASS} OAuth2 token refresh succesvol`);
        }
    } catch (error) {
        console.log(`${FAIL} OAuth2 token refresh mislukt: ${error.response?.data?.error || error.message}`);
    }
}

async function testMetaAds() {
    console.log('\n📘 Meta / Facebook Ads API');
    console.log('─'.repeat(40));

    const accessToken = process.env.META_ACCESS_TOKEN;
    const adAccountId = process.env.META_AD_ACCOUNT_ID;

    if (!accessToken) return console.log(`${SKIP} META_ACCESS_TOKEN niet ingesteld`);
    if (!adAccountId) return console.log(`${SKIP} META_AD_ACCOUNT_ID niet ingesteld`);

    console.log(`${PASS} Credentials aanwezig`);

    try {
        const response = await axios.get(
            `https://graph.facebook.com/v21.0/${adAccountId}`,
            {
                params: {
                    access_token: accessToken,
                    fields: 'name,account_status,currency',
                },
                timeout: 10000,
            }
        );

        const status = response.data.account_status === 1 ? 'ACTIEF' : `status ${response.data.account_status}`;
        console.log(`${PASS} Ad Account: ${response.data.name} (${status}, ${response.data.currency})`);
    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        console.log(`${FAIL} Meta API fout: ${errMsg}`);
    }
}

// ──────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════╗
║       Offgrid Storings-Tracker — Connectie Test         ║
╚══════════════════════════════════════════════════════════╝`);

try {
    await testOutageApi();
    await testGoogleAds();
    await testMetaAds();
} catch (error) {
    console.error(`\n${FAIL} Onverwachte fout: ${error.message}`);
}

console.log('\n' + '═'.repeat(50));
console.log('Test voltooid.\n');
