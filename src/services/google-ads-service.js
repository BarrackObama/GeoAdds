import logger from '../utils/logger.js';
import { getCityFromOutage, getProvinceFromOutage, parsePostcodes } from '../utils/postcode-utils.js';

/**
 * GoogleAdsService — Automatische Google Ads campagne-aanmaak bij stroomstoringen.
 *
 * Gebruikt het google-ads-api npm package.
 * Maakt Search Campaigns aan met proximity geo-targeting, responsive search ads,
 * en keywords gericht op thuisbatterijen / noodstroom.
 */
class GoogleAdsService {
    constructor() {
        this.enabled = false;
        this.client = null;
        this.customer = null;
        this.landingPageUrl = process.env.LANDING_PAGE_URL || 'https://offgridcentrum.nl/thuisbatterij';
        this.simulationMode = process.env.SIMULATION_MODE === 'true';

        this._initialize();
    }

    async _initialize() {
        const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
        const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
        const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
        const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
        const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

        if (this.simulationMode) {
            this.enabled = true;
            logger.info('🧪 Google Ads service geïnitialiseerd in SIMULATIE MODUS');
            return;
        }

        if (!clientId || !clientSecret || !developerToken || !refreshToken || !customerId) {
            logger.warn(
                '⚠️  Google Ads credentials niet (volledig) geconfigureerd — ' +
                'Google Ads campagnes worden NIET aangemaakt. ' +
                'Voer `npm run setup:google` uit om de credentials in te stellen.'
            );
            return;
        }

        try {
            const { GoogleAdsApi } = await import('google-ads-api');

            this.client = new GoogleAdsApi({
                client_id: clientId,
                client_secret: clientSecret,
                developer_token: developerToken,
            });

            this.customer = this.client.Customer({
                customer_id: customerId,
                login_customer_id: loginCustomerId || customerId,
                refresh_token: refreshToken,
            });

            this.enabled = true;
            logger.info('✅ Google Ads service geïnitialiseerd');
        } catch (error) {
            logger.error(`Google Ads initialisatie mislukt: ${error.message}`);
        }
    }

    /**
     * Maak een volledige Google Ads campagne aan voor een storing.
     * @param {object} outage – verrijkte storingsdata
     * @param {object} [options] – optionele overrides (budget, radius)
     * @returns {object|null} Campagnedata of null bij fout
     */
    async createCampaign(outage, options = {}) {
        if (!this.enabled) {
            logger.debug('Google Ads: overgeslagen (niet geconfigureerd)');
            return null;
        }

        if (this.simulationMode) {
            return this._createSimulatedCampaign(outage, options);
        }

        const city = getCityFromOutage(outage);
        const province = getProvinceFromOutage(outage);

        // Gebruik overrides indien aanwezig
        const budget = options.customBudget || outage._severity.googleBudget;
        const radiusKm = options.customRadius || outage._severity.radiusKm;
        const durationHours = options.customDuration || 72;

        const campaignName = `Storing ${city} - ${new Date().toISOString().split('T')[0]} - ${outage._severity.label}`;

        try {
            // 1. Maak CampaignBudget aan
            const budgetResult = await this.customer.campaignBudgets.create([
                {
                    name: `Budget - ${campaignName}`,
                    amount_micros: budget * 1_000_000, // Dagbudget in micros
                    delivery_method: 'STANDARD',
                    explicitly_shared: false,
                },
            ]);

            const budgetResourceName = budgetResult.results[0].resource_name;
            logger.info(`Google Ads: Budget aangemaakt — €${budget}/dag`);

            // 2. Maak Campaign aan
            const endDate = new Date(Date.now() + durationHours * 60 * 60 * 1000);
            const startDate = new Date();

            const campaignResult = await this.customer.campaigns.create([
                {
                    name: campaignName,
                    campaign_budget: budgetResourceName,
                    advertising_channel_type: 'SEARCH',
                    status: 'ENABLED',
                    start_date: this._formatDate(startDate),
                    end_date: this._formatDate(endDate),
                    bidding_strategy_type: 'MAXIMIZE_CLICKS',
                    network_settings: {
                        target_google_search: true,
                        target_search_network: true,
                        target_content_network: false,
                    },
                },
            ]);

            const campaignResourceName = campaignResult.results[0].resource_name;
            const campaignId = campaignResourceName.split('/').pop();
            logger.info(`Google Ads: Campaign aangemaakt — ${campaignName} (ID: ${campaignId})`);

            // 3. Geo-targeting (proximity rondom de storing)
            const coords = outage.location?.features?.geometry?.coordinates || [0, 0];
            if (coords[0] !== 0 && coords[1] !== 0) {
                await this.customer.campaignCriteria.create([
                    {
                        campaign: campaignResourceName,
                        proximity: {
                            geo_point: {
                                latitude_in_micro_degrees: Math.round(coords[0] * 1_000_000),
                                longitude_in_micro_degrees: Math.round(coords[1] * 1_000_000),
                            },
                            radius: radiusKm,
                            radius_units: 'KILOMETERS',
                            address: {
                                city_name: city,
                                province_name: province || '',
                                country_code: 'NL',
                            },
                        },
                    },
                ]);
                logger.info(`Google Ads: Geo-targeting ingesteld — ${radiusKm}km rond ${city}`);
            }

            // 4. Maak Ad Group aan
            const adGroupResult = await this.customer.adGroups.create([
                {
                    name: `AdGroup - Stroomstoring ${city}`,
                    campaign: campaignResourceName,
                    status: 'ENABLED',
                    type: 'SEARCH_STANDARD',
                },
            ]);

            const adGroupResourceName = adGroupResult.results[0].resource_name;

            // 5. Voeg keywords toe
            const keywords = this._generateKeywords(city, province);
            const keywordOperations = keywords.map((kw) => ({
                ad_group: adGroupResourceName,
                keyword: {
                    text: kw.text,
                    match_type: kw.matchType,
                },
                status: 'ENABLED',
            }));

            await this.customer.adGroupCriteria.create(keywordOperations);
            logger.info(`Google Ads: ${keywords.length} keywords toegevoegd`);

            // 6. Maak Responsive Search Ad
            await this.customer.ads.create([
                {
                    ad_group: adGroupResourceName,
                    ad: {
                        responsive_search_ad: {
                            headlines: [
                                { text: 'Stroomstoring? Nooit Meer!' },
                                { text: 'Thuisbatterij Vanaf €3.999' },
                                { text: 'Gratis Adviesgesprek' },
                                { text: `Stroomstoring in ${city.substring(0, 20)}` },
                                { text: 'Bescherm Je Gezin' },
                                { text: '10 Jaar Garantie' },
                                { text: 'Directe Noodstroom' },
                                { text: 'Offgridcentrum.nl' },
                                { text: 'Werkt Met Zonnepanelen' },
                                { text: 'Binnen 2 Weken Geïnstalleerd' },
                                { text: 'Professioneel Advies' },
                                { text: 'Nooit Meer Zonder Stroom' },
                            ],
                            descriptions: [
                                {
                                    text: 'Bescherm je gezin tegen stroomstoringen met een thuisbatterij van Offgridcentrum. Vraag gratis advies aan!',
                                },
                                {
                                    text: 'Automatische overschakeling bij stroomuitval. Werkt met zonnepanelen. 10 jaar garantie. Bestel nu!',
                                },
                                {
                                    text: 'Stroomstoringen worden steeds vaker. Investeer in een thuisbatterij en wees voorbereid. Offgridcentrum helpt.',
                                },
                                {
                                    text: 'Van stroomstoring naar energieonafhankelijkheid. Onze thuisbatterijen bieden zekerheid wanneer het net uitvalt.',
                                },
                            ],
                            path1: 'thuisbatterij',
                            path2: 'noodstroom',
                        },
                        final_urls: [this.landingPageUrl],
                    },
                    status: 'ENABLED',
                },
            ]);
            logger.info('Google Ads: Responsive Search Ad aangemaakt');

            const campaignData = {
                campaignId,
                campaignName,
                campaignResourceName,
                budgetResourceName,
                adGroupResourceName,
                budget: budget,
                radiusKm: radiusKm,
                city,
                platform: 'google',
            };

            return campaignData;
        } catch (error) {
            logger.error(`Google Ads campagne-aanmaak mislukt: ${error.message}`);
            if (error.errors) {
                error.errors.forEach((e) =>
                    logger.error(`  → ${e.message || JSON.stringify(e)}`)
                );
            }
            return null;
        }
    }

    /**
     * Maak een gefingeerde campagne voor testdoeleinden.
     */
    async _createSimulatedCampaign(outage, options = {}) {
        const city = getCityFromOutage(outage);
        const budget = options.customBudget || outage._severity.googleBudget;
        const radiusKm = options.customRadius || outage._severity.radiusKm;
        const campaignId = `SIM_${Math.floor(Math.random() * 1000000)}`;
        const campaignName = `[SIMULATIE] Storing ${city} - ${new Date().toISOString().split('T')[0]}`;

        logger.info(`🧪 GESTIMULEERD: Google Ads campaign — ${campaignName} (€${budget}, ${radiusKm}km)`);

        return {
            campaignId,
            campaignName,
            campaignResourceName: `customers/123/campaigns/${campaignId}`,
            budgetResourceName: `customers/123/campaignBudgets/${campaignId}`,
            adGroupResourceName: `customers/123/adGroups/${campaignId}`,
            budget: budget,
            radiusKm: radiusKm,
            city,
            platform: 'google',
            simulated: true,
        };
    }

    /**
     * Pauzeer een Google Ads campagne.
     */
    async pauseCampaign(campaignResourceName) {
        if (!this.enabled) return false;

        if (this.simulationMode) {
            logger.info(`🧪 GESTIMULEERD: Campagne gepauzeerd — ${campaignResourceName}`);
            return true;
        }

        try {
            await this.customer.campaigns.update([
                {
                    resource_name: campaignResourceName,
                    status: 'PAUSED',
                },
            ]);
            logger.info(`Google Ads: Campagne gepauzeerd — ${campaignResourceName}`);
            return true;
        } catch (error) {
            logger.error(`Google Ads campagne pauzeren mislukt: ${error.message}`);
            return false;
        }
    }

    /**
     * Genereer keywords voor een storing in een bepaalde stad/provincie.
     */
    _generateKeywords(city, province) {
        const baseKeywords = [
            { text: 'stroomstoring', matchType: 'PHRASE' },
            { text: 'thuisbatterij', matchType: 'PHRASE' },
            { text: 'noodstroom thuis', matchType: 'PHRASE' },
            { text: 'stroomuitval oplossing', matchType: 'PHRASE' },
            { text: 'thuisbatterij kopen', matchType: 'PHRASE' },
            { text: 'home battery', matchType: 'PHRASE' },
            { text: 'noodstroom systeem', matchType: 'PHRASE' },
            { text: 'stroomstoring oplossing', matchType: 'BROAD' },
            { text: 'thuisaccu', matchType: 'PHRASE' },
            { text: 'batterij opslag thuis', matchType: 'BROAD' },
        ];

        // Stadspecifieke keywords
        if (city && city !== 'Onbekend') {
            baseKeywords.push(
                { text: `stroomstoring ${city}`, matchType: 'PHRASE' },
                { text: `thuisbatterij ${city}`, matchType: 'BROAD' },
                { text: `noodstroom ${city}`, matchType: 'BROAD' }
            );
        }

        // Provinciespecifieke keywords
        if (province) {
            baseKeywords.push(
                { text: `stroomstoring ${province}`, matchType: 'PHRASE' },
                { text: `thuisbatterij ${province}`, matchType: 'BROAD' }
            );
        }

        return baseKeywords;
    }

    /**
     * Formatteer datum naar YYYY-MM-DD (Google Ads formaat).
     */
    _formatDate(date) {
        return date.toISOString().split('T')[0];
    }

    /**
     * Check of de service geconfigureerd is.
     */
    isEnabled() {
        return this.enabled;
    }
}

export default GoogleAdsService;
