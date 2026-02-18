import axios from 'axios';
import logger from '../utils/logger.js';

/**
 * ScraperService — Haalt storingsdata op uit energieonderbrekingen.nl
 *
 * Ondersteunt 3 modi:
 *   api     → Auth0 OAuth2 M2M → GET /api/v2/disruptions
 *   scrape  → Playwright headless browser, onderschept XHR-responses
 *   hybrid  → API eerst, daarna scrape als fallback
 */
class ScraperService {
    constructor() {
        this.mode = process.env.DATA_SOURCE_MODE || 'scrape';
        this.apiBaseUrl = 'https://energieonderbrekingen.nl/api/v2';
        this.authUrl = process.env.OUTAGE_AUTH_URL || 'https://energieonderbrekingen.eu.auth0.com/oauth/token';
        this.clientId = process.env.OUTAGE_API_CLIENT_ID;
        this.clientSecret = process.env.OUTAGE_API_CLIENT_SECRET;
        this.audience = process.env.OUTAGE_API_AUDIENCE || 'https://energieonderbrekingen.nl/api/v2';

        // Token cache
        this._accessToken = null;
        this._tokenExpiresAt = 0;

        // Playwright browser instance (lazy init)
        this._browser = null;

        logger.info(`ScraperService geïnitialiseerd in modus: ${this.mode}`);
    }

    // ──────────────────────────────────────
    //  Publieke methode — haal storingen op
    // ──────────────────────────────────────

    async fetchOutages() {
        try {
            switch (this.mode) {
                case 'api':
                    return await this._fetchViaApi();

                case 'scrape':
                    return await this._fetchViaScraping();

                case 'hybrid':
                    return await this._fetchHybrid();

                default:
                    logger.warn(`Onbekende DATA_SOURCE_MODE: ${this.mode}, val terug op scraping`);
                    return await this._fetchViaScraping();
            }
        } catch (error) {
            logger.error('Fout bij ophalen storingsdata:', error);
            return [];
        }
    }

    // ──────────────────────────
    //  Modus 1 — Auth0 API
    // ──────────────────────────

    async _fetchViaApi() {
        if (!this.clientId || !this.clientSecret) {
            logger.warn('OUTAGE_API_CLIENT_ID/SECRET niet geconfigureerd — kan API niet gebruiken');
            return [];
        }

        const token = await this._getAccessToken();
        if (!token) return [];

        try {
            const response = await axios.get(`${this.apiBaseUrl}/disruptions`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
                timeout: 15000,
            });

            const data = response.data;
            const disruptions = Array.isArray(data) ? data : data?.disruptions || data?.data || [];

            logger.info(`API: ${disruptions.length} storingen opgehaald`);
            return disruptions.map((d) => this._normalizeOutage(d));
        } catch (error) {
            logger.error(`API-fout bij ophalen storingen: ${error.message}`);
            return [];
        }
    }

    async _getAccessToken() {
        // Gebruik cached token als deze nog geldig is (met 60s marge)
        if (this._accessToken && Date.now() < this._tokenExpiresAt - 60_000) {
            return this._accessToken;
        }

        try {
            const response = await axios.post(this.authUrl, {
                client_id: this.clientId,
                client_secret: this.clientSecret,
                audience: this.audience,
                grant_type: 'client_credentials',
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
            });

            this._accessToken = response.data.access_token;
            // Token geldig voor expires_in seconden (standaard ~36000 = 10 uur)
            const expiresIn = response.data.expires_in || 36000;
            this._tokenExpiresAt = Date.now() + expiresIn * 1000;

            logger.info(`Auth0 token verkregen, geldig voor ${Math.round(expiresIn / 3600)} uur`);
            return this._accessToken;
        } catch (error) {
            logger.error(`Fout bij verkrijgen Auth0 token: ${error.message}`);
            this._accessToken = null;
            return null;
        }
    }

    // ──────────────────────────────────────
    //  Modus 2 — Playwright Scraping
    // ──────────────────────────────────────

    async _fetchViaScraping() {
        let browser = null;
        let context = null;
        let page = null;

        try {
            // Dynamische import (playwright is een devDependency)
            const { chromium } = await import('playwright');

            const interceptedData = [];

            browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });

            context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            });

            page = await context.newPage();

            // Onderschep XHR/fetch responses die storingsdata bevatten
            page.on('response', async (response) => {
                try {
                    const url = response.url();
                    const contentType = response.headers()['content-type'] || '';

                    // Log alle API-achtige calls voor debug
                    if (url.includes('/api/')) {
                        logger.debug(`API Call onderschept: ${url} (Status: ${response.status()}, Type: ${contentType})`);
                    }

                    if (
                        (url.includes('/api/') && (url.includes('disruption') || url.includes('storing') || url.includes('onderbreking'))) &&
                        response.status() === 200 &&
                        contentType.includes('application/json')
                    ) {
                        const json = await response.json();
                        interceptedData.push(json);
                        logger.info(`✅ Data onderschept van: ${url}`);
                    }
                } catch (e) {
                    // Negeer parse-fouten bij niet-JSON responses
                }
            });

            const targetUrl = 'https://energieonderbrekingen.nl/onderbrekingen';
            logger.info(`Scraper: navigeren naar ${targetUrl}...`);
            await page.goto(targetUrl, {
                waitUntil: 'networkidle',
                timeout: 45000,
            });

            // Wacht extra op data-laden
            await page.waitForTimeout(8000);

            // Probeer ook de DOM te parsen als fallback
            let domOutages = [];
            try {
                domOutages = await page.evaluate(() => {
                    // Zoek specifiek naar elementen in de lijst op /onderbrekingen
                    const cards = document.querySelectorAll('[class*="disruption"], [class*="outage"], [class*="storing"], [class*="ListItem"], article');
                    return Array.from(cards).map((card) => ({
                        text: card.textContent?.trim(),
                        html: card.innerHTML,
                    }));
                });
            } catch (e) {
                logger.debug(`DOM parsing waarschuwing: ${e.message}`);
                // DOM parsing mislukt — geen probleem als XHR data is onderschept
            }

            // Verwerk onderschepte data
            let disruptions = [];
            for (const data of interceptedData) {
                // Soms komt de data direct als array, soms in een disruptions/data/items veld
                const items = Array.isArray(data)
                    ? data
                    : data?.disruptions || data?.data || data?.items || data?.disruptionOccurrences || [];

                if (Array.isArray(items)) {
                    disruptions.push(...items);
                } else if (typeof data === 'object' && data !== null) {
                    // Misschien is het een enkel object?
                    if (data.id || data._id) disruptions.push(data);
                }
            }

            if (disruptions.length > 0) {
                logger.info(`Scraper: ${disruptions.length} incidenten onderschept via XHR`);
                return disruptions.map((d) => this._normalizeOutage(d));
            }

            if (domOutages.length > 0) {
                // Filter alleen relevante DOM elementen (die iets van text bevatten)
                const relevantDom = domOutages.filter(d => d.text && d.text.length > 20);
                if (relevantDom.length > 0) {
                    logger.info(`Scraper: ${relevantDom.length} elementen gevonden in DOM via fallback`);
                    return relevantDom.map((d, i) => this._normalizeFromDom(d, i));
                }
            }

            logger.warn('Scraper: geen storingsdata gevonden. Controleer of de URL of selectors nog kloppen.');
            return [];
        } catch (error) {
            logger.error(`Scraping-fout: ${error.message}`);

            // Als Playwright niet geïnstalleerd is, geef duidelijke melding
            if (error.message.includes('Cannot find module') || error.message.includes('playwright')) {
                logger.error(
                    'Playwright is niet geïnstalleerd. Run: npx playwright install chromium'
                );
            }
            return [];
        } finally {
            try {
                if (page) await page.close();
                if (context) await context.close();
                if (browser) await browser.close();
            } catch {
                // Negeer afsluiting-fouten
            }
        }
    }

    // ──────────────────────────
    //  Modus 3 — Hybrid
    // ──────────────────────────

    async _fetchHybrid() {
        // Probeer API eerst
        if (this.clientId && this.clientSecret) {
            const apiResult = await this._fetchViaApi();
            if (apiResult.length > 0) return apiResult;
            logger.warn('Hybrid: API leverde geen data, val terug op scraping');
        }

        return await this._fetchViaScraping();
    }

    // ──────────────────────────
    //  Data normalisatie
    // ──────────────────────────

    _normalizeOutage(raw) {
        try {
            // Het verwachte datamodel volgt het energieonderbrekingen.nl schema
            return {
                id: raw.id || raw._id || `generated-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                source: {
                    organisation: raw.source?.organisation || raw.netbeheerder || 'Onbekend',
                    timestamp: raw.source?.timestamp || raw.updatedAt || new Date().toISOString(),
                },
                network: {
                    type: raw.network?.type || raw.energieType || 'electricity',
                },
                period: {
                    begin: raw.period?.begin || raw.startTime || raw.begin || '',
                    end: raw.period?.end || raw.endTime || raw.end || '',
                    expectedEnd: raw.period?.expectedEnd || raw.expectedEnd || '',
                },
                impact: {
                    households: raw.impact?.households || raw.aantalGetroffen || raw.households || 0,
                },
                location: {
                    features: {
                        geometry: {
                            coordinates: this._extractCoordinates(raw),
                            type: 'Point',
                        },
                        properties: {
                            city: raw.location?.features?.properties?.city || raw.stad || raw.city || '',
                            postalCode: raw.location?.features?.properties?.postalCode || raw.postcode || raw.postalCode || '',
                            street: raw.location?.features?.properties?.street || raw.straat || raw.street || '',
                        },
                    },
                },
                cause: raw.cause || raw.oorzaak || '',
                status: raw.status || 'onbekend',
                message: raw.message || raw.bericht || '',
                // Interne tracking velden
                _firstSeen: new Date().toISOString(),
                _lastUpdated: new Date().toISOString(),
                _raw: raw,
            };
        } catch (error) {
            logger.warn(`Normalisatiefout voor storing: ${error.message}`);
            return {
                id: `parse-error-${Date.now()}`,
                source: { organisation: 'Onbekend', timestamp: new Date().toISOString() },
                network: { type: 'electricity' },
                period: { begin: '', end: '', expectedEnd: '' },
                impact: { households: 0 },
                location: {
                    features: {
                        geometry: { coordinates: [0, 0], type: 'Point' },
                        properties: { city: '', postalCode: '', street: '' },
                    },
                },
                cause: '',
                status: 'onbekend',
                message: '',
                _firstSeen: new Date().toISOString(),
                _lastUpdated: new Date().toISOString(),
                _raw: raw,
            };
        }
    }

    _normalizeFromDom(domData, index) {
        // Probeer basale info uit DOM-tekst te extraheren
        const text = domData.text || '';
        const postcodeMatch = text.match(/\b\d{4}\s?[A-Z]{2}\b/g);
        const cityMatch = text.match(/(?:in|te)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
        const householdMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:huishoudens|adressen|aansluitingen)/i);

        return {
            id: `dom-${Date.now()}-${index}`,
            source: { organisation: 'Onbekend (DOM)', timestamp: new Date().toISOString() },
            network: { type: 'electricity' },
            period: { begin: '', end: '', expectedEnd: '' },
            impact: {
                households: householdMatch ? parseInt(householdMatch[1].replace('.', ''), 10) : 0,
            },
            location: {
                features: {
                    geometry: { coordinates: [0, 0], type: 'Point' },
                    properties: {
                        city: cityMatch ? cityMatch[1] : '',
                        postalCode: postcodeMatch ? postcodeMatch.join(';') : '',
                        street: '',
                    },
                },
            },
            cause: '',
            status: 'actief',
            message: text.substring(0, 200),
            _firstSeen: new Date().toISOString(),
            _lastUpdated: new Date().toISOString(),
            _raw: domData,
        };
    }

    _extractCoordinates(raw) {
        // Probeer coördinaten uit diverse mogelijke structuren te halen
        if (raw.location?.features?.geometry?.coordinates) {
            return raw.location.features.geometry.coordinates;
        }
        if (raw.geometry?.coordinates) {
            return raw.geometry.coordinates;
        }
        if (raw.lat && raw.lng) {
            return [raw.lat, raw.lng];
        }
        if (raw.latitude && raw.longitude) {
            return [raw.latitude, raw.longitude];
        }
        return [0, 0];
    }

    // ──────────────────────────
    //  Cleanup
    // ──────────────────────────

    async close() {
        if (this._browser) {
            try {
                await this._browser.close();
            } catch {
                // Negeer
            }
            this._browser = null;
        }
    }
}

export default ScraperService;
