import logger from '../utils/logger.js';
import { getCityFromOutage, getProvinceFromOutage } from '../utils/postcode-utils.js';

/**
 * MetaAdsService — Automatische Meta/Facebook Ads campagne-aanmaak bij stroomstoringen.
 *
 * Gebruikt het facebook-nodejs-business-sdk npm package.
 * Maakt Traffic-campagnes aan met radius geo-targeting, interesse-targeting
 * en advertenties gericht op thuisbatterijen.
 */
class MetaAdsService {
    constructor() {
        this.enabled = false;
        this.adAccountId = null;
        this.pageId = null;
        this.AdAccount = null;
        this.Campaign = null;
        this.AdSet = null;
        this.AdCreative = null;
        this.Ad = null;
        this.landingPageUrl = process.env.LANDING_PAGE_URL || 'https://offgridcentrum.nl/thuisbatterij';

        this._initialize();
    }

    async _initialize() {
        const appId = process.env.META_APP_ID;
        const appSecret = process.env.META_APP_SECRET;
        const accessToken = process.env.META_ACCESS_TOKEN;
        this.adAccountId = process.env.META_AD_ACCOUNT_ID;
        this.pageId = process.env.META_PAGE_ID;

        if (!appId || !appSecret || !accessToken || !this.adAccountId) {
            logger.warn(
                '⚠️  Meta Ads credentials niet (volledig) geconfigureerd — ' +
                'Meta Ads campagnes worden NIET aangemaakt. ' +
                'Voer `npm run setup:meta` uit om de credentials in te stellen.'
            );
            return;
        }

        try {
            const bizSdk = await import('facebook-nodejs-business-sdk');
            const FacebookAdsApi = bizSdk.default?.FacebookAdsApi || bizSdk.FacebookAdsApi;
            const AdAccountClass = bizSdk.default?.AdAccount || bizSdk.AdAccount;
            const CampaignClass = bizSdk.default?.Campaign || bizSdk.Campaign;
            const AdSetClass = bizSdk.default?.AdSet || bizSdk.AdSet;
            const AdCreativeClass = bizSdk.default?.AdCreative || bizSdk.AdCreative;
            const AdClass = bizSdk.default?.Ad || bizSdk.Ad;

            FacebookAdsApi.init(accessToken);

            this.AdAccount = AdAccountClass;
            this.Campaign = CampaignClass;
            this.AdSet = AdSetClass;
            this.AdCreative = AdCreativeClass;
            this.Ad = AdClass;
            this.adAccount = new AdAccountClass(this.adAccountId);

            this.enabled = true;
            logger.info('✅ Meta Ads service geïnitialiseerd');
        } catch (error) {
            logger.error(`Meta Ads initialisatie mislukt: ${error.message}`);
        }
    }

    /**
     * Maak een volledige Meta Ads campagne aan voor een storing.
     * @param {object} outage – verrijkte storingsdata
     * @returns {object|null} Campagnedata of null bij fout
     */
    async createCampaign(outage) {
        if (!this.enabled) {
            logger.debug('Meta Ads: overgeslagen (niet geconfigureerd)');
            return null;
        }

        const city = getCityFromOutage(outage);
        const severity = outage._severity;
        const campaignName = `[Storing] ${city} - ${new Date().toISOString().split('T')[0]}`;

        try {
            // 1. Maak Campaign aan
            const campaign = await this.adAccount.createCampaign([], {
                name: campaignName,
                objective: 'OUTCOME_TRAFFIC',
                status: 'ACTIVE',
                special_ad_categories: [],
            });

            const campaignId = campaign.id;
            logger.info(`Meta Ads: Campaign aangemaakt — ${campaignName} (ID: ${campaignId})`);

            // 2. Maak Ad Set aan met targeting
            const coords = outage.location?.features?.geometry?.coordinates || [0, 0];
            const endTime = new Date(Date.now() + 72 * 60 * 60 * 1000);

            const targeting = {
                geo_locations: {
                    custom_locations: [
                        {
                            latitude: coords[0],
                            longitude: coords[1],
                            radius: severity.radiusKm,
                            distance_unit: 'kilometer',
                        },
                    ],
                },
                age_min: 25,
                age_max: 65,
                locales: [25], // Nederlands
                interests: [
                    { id: '6003384285438', name: 'Solar energy' },
                    { id: '6003397425735', name: 'Home improvement' },
                    { id: '6003349442805', name: 'Renewable energy' },
                    { id: '6003507258557', name: 'Sustainability' },
                    { id: '6003233490265', name: 'Environmentalism' },
                ],
                publisher_platforms: ['facebook', 'instagram'],
                facebook_positions: ['feed'],
                instagram_positions: ['stream', 'story'],
            };

            const adSet = await this.adAccount.createAdSet([], {
                name: `AdSet - Stroomstoring ${city}`,
                campaign_id: campaignId,
                daily_budget: Math.round(severity.metaBudget * 100), // Budget in centen
                billing_event: 'IMPRESSIONS',
                optimization_goal: 'LINK_CLICKS',
                bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
                targeting,
                start_time: new Date().toISOString(),
                end_time: endTime.toISOString(),
                status: 'ACTIVE',
            });

            const adSetId = adSet.id;
            logger.info(`Meta Ads: Ad Set aangemaakt — radius ${severity.radiusKm}km rond ${city}`);

            // 3. Maak Ad Creative
            const adCreative = await this.adAccount.createAdCreative([], {
                name: `Creative - Stroomstoring ${city}`,
                object_story_spec: {
                    page_id: this.pageId,
                    link_data: {
                        link: this.landingPageUrl,
                        message: this._generateAdBody(city, outage),
                        name: `🔋 Stroomstoring in ${city}? Nooit meer!`,
                        description:
                            'Bescherm je huis tegen stroomstoringen met een thuisbatterij van Offgridcentrum.',
                        call_to_action: {
                            type: 'LEARN_MORE',
                            value: { link: this.landingPageUrl },
                        },
                    },
                },
            });

            const creativeId = adCreative.id;
            logger.info(`Meta Ads: Ad Creative aangemaakt`);

            // 4. Maak Ad aan
            const ad = await this.adAccount.createAd([], {
                name: `Ad - Stroomstoring ${city}`,
                adset_id: adSetId,
                creative: { creative_id: creativeId },
                status: 'ACTIVE',
            });

            logger.info(`Meta Ads: Ad aangemaakt (ID: ${ad.id})`);

            const campaignData = {
                campaignId,
                adSetId,
                creativeId,
                adId: ad.id,
                campaignName,
                budget: severity.metaBudget,
                radiusKm: severity.radiusKm,
                city,
                platform: 'meta',
            };

            return campaignData;
        } catch (error) {
            logger.error(`Meta Ads campagne-aanmaak mislukt: ${error.message}`);
            if (error.response?.error) {
                logger.error(`  → Meta API Error: ${JSON.stringify(error.response.error)}`);
            }
            return null;
        }
    }

    /**
     * Pauzeer een Meta Ads campagne.
     */
    async pauseCampaign(campaignId) {
        if (!this.enabled) return false;

        try {
            const campaign = new this.Campaign(campaignId);
            await campaign.update([], {
                status: 'PAUSED',
            });
            logger.info(`Meta Ads: Campagne gepauzeerd — ${campaignId}`);
            return true;
        } catch (error) {
            logger.error(`Meta Ads campagne pauzeren mislukt: ${error.message}`);
            return false;
        }
    }

    /**
     * Genereer de advertentietekst voor een storing.
     */
    _generateAdBody(city, outage) {
        const households = outage.impact?.households || 0;
        const householdText = households > 0 ? `${households.toLocaleString('nl-NL')} huishoudens getroffen. ` : '';

        return (
            `⚡ Weer een stroomstoring in ${city}! ${householdText}` +
            `Stroomstoringen worden steeds vaker in Nederland.\n\n` +
            `Bescherm je huis met een thuisbatterij van Offgridcentrum:\n` +
            `✅ Automatische overschakeling bij stroomuitval\n` +
            `✅ Werkt perfect met zonnepanelen\n` +
            `✅ 10 jaar garantie\n` +
            `✅ Binnen 2 weken geïnstalleerd\n\n` +
            `Vraag nu je gratis adviesgesprek aan! 👉`
        );
    }

    /**
     * Check of de service geconfigureerd is.
     */
    isEnabled() {
        return this.enabled;
    }
}

export default MetaAdsService;
