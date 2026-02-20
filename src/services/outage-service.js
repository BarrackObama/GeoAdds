import logger from '../utils/logger.js';
import { getCityFromOutage, getProvinceFromOutage } from '../utils/postcode-utils.js';
import { save, load } from '../utils/persistence.js';

/**
 * OutageService — Storingsdetectie, classificatie en state management
 *
 * Houdt de staat van alle bekende storingen bij, detecteert nieuwe/opgeloste
 * storingen en bepaalt de campagne-parameters (budget, radius) op basis van ernst.
 */

// Severity classificatie
const SEVERITY = {
    MINOR: 'minor',     // < 1.000 huishoudens
    MAJOR: 'major',     // 1.000 - 3.000 huishoudens
    CRITICAL: 'critical', // > 3.000 huishoudens
};

// Budget en radius per severity
const SEVERITY_CONFIG = {
    [SEVERITY.MINOR]: {
        googleBudget: 15,  // €/dag
        metaBudget: 12,    // €/dag
        radiusKm: 5,
        label: 'Klein',
    },
    [SEVERITY.MAJOR]: {
        googleBudget: 35,
        metaBudget: 30,
        radiusKm: 10,
        label: 'Groot',
    },
    [SEVERITY.CRITICAL]: {
        googleBudget: 60,
        metaBudget: 50,
        radiusKm: 15,
        label: 'Kritiek',
    },
};

class OutageService {
    constructor() {
        // State: Map<outageId, outageRecord>
        this.activeOutages = new Map();
        // Opgeloste storingen (bewaar voor 24 uur voor dashboard)
        this.resolvedOutages = new Map();
        // Campagne-koppelingen: Map<outageId, { google: {}, meta: {} }>
        this.campaigns = new Map();
        // Event log (max 200 entries)
        this.eventLog = [];

        this.campaignDurationHours = parseInt(process.env.CAMPAIGN_DURATION_HOURS || '72', 10);
        this.maxDailyBudgetGoogle = parseFloat(process.env.MAX_DAILY_BUDGET_GOOGLE || '150');
        this.maxDailyBudgetMeta = parseFloat(process.env.MAX_DAILY_BUDGET_META || '150');
        this.totalMaxDailyBudgetGoogle = parseFloat(process.env.TOTAL_MAX_DAILY_BUDGET_GOOGLE || '500');
        this.totalMaxDailyBudgetMeta = parseFloat(process.env.TOTAL_MAX_DAILY_BUDGET_META || '500');

        // Laad opgeslagen state
        this._loadState();

        logger.info('OutageService geïnitialiseerd');
    }

    /**
     * Voeg een event toe aan de log.
     */
    addEvent(type, message, data = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            message,
            data,
        };
        this.eventLog.unshift(entry);
        if (this.eventLog.length > 200) {
            this.eventLog.length = 200;
        }
        return entry;
    }

    /**
     * Laad opgeslagen state van disk (overleeft herstart).
     */
    _loadState() {
        const savedActive = load('active_outages', []);
        const savedResolved = load('resolved_outages', []);
        const savedCampaigns = load('campaigns', []);
        this.eventLog = load('event_log', []);

        for (const o of savedActive) {
            this.activeOutages.set(o.id, o);
        }
        for (const o of savedResolved) {
            this.resolvedOutages.set(o.id, o);
        }
        for (const c of savedCampaigns) {
            this.campaigns.set(c.outageId, c.platforms);
        }

        if (savedActive.length > 0 || savedCampaigns.length > 0 || this.eventLog.length > 0) {
            logger.info(`State geladen: ${savedActive.length} actieve storingen, ${savedCampaigns.length} campagnes, ${this.eventLog.length} logs`);
        }
    }

    /**
     * Sla huidige state op naar disk.
     */
    _saveState() {
        save('active_outages', Array.from(this.activeOutages.values()));
        save('resolved_outages', Array.from(this.resolvedOutages.values()));
        save('event_log', this.eventLog);

        const campaignData = [];
        for (const [outageId, platforms] of this.campaigns) {
            campaignData.push({ outageId, platforms });
        }
        save('campaigns', campaignData);
    }

    /**
     * Verwerk nieuwe storingsdata van de scraper.
     * @param {object[]} freshOutages – genormaliseerde storingen
     * @returns {{ newOutages: object[], resolvedOutages: object[], updatedOutages: object[] }}
     */
    processOutages(freshOutages) {
        const freshIds = new Set(freshOutages.map((o) => o.id));
        const newOutages = [];
        const updatedOutages = [];
        const resolvedOutagesList = [];

        // 1. Detecteer NIEUWE en BIJGEWERKTE storingen
        for (const outage of freshOutages) {
            const existing = this.activeOutages.get(outage.id);

            if (!existing) {
                // Nieuwe storing!
                const enriched = this._enrichOutage(outage);
                this.activeOutages.set(outage.id, enriched);
                newOutages.push(enriched);
                logger.info(
                    `🆕 Nieuwe storing: ${enriched.id} in ${getCityFromOutage(enriched)} ` +
                    `(${enriched._severity.label}, ${enriched.impact.households} huishoudens)`
                );
            } else {
                // Bestaande storing — update
                const updated = {
                    ...existing,
                    ...outage,
                    _firstSeen: existing._firstSeen,
                    _severity: this._classifySeverity(outage),
                    _lastUpdated: new Date().toISOString(),
                };
                this.activeOutages.set(outage.id, updated);

                // Check of status is gewijzigd
                if (existing.status !== outage.status) {
                    updatedOutages.push(updated);
                    logger.info(`🔄 Storing bijgewerkt: ${outage.id} — status: ${existing.status} → ${outage.status}`);
                }
            }
        }

        // 2. Detecteer OPGELOSTE storingen (in onze state maar niet meer in verse data)
        for (const [id, outage] of this.activeOutages) {
            if (!freshIds.has(id)) {
                outage._resolvedAt = new Date().toISOString();
                this.resolvedOutages.set(id, outage);
                this.activeOutages.delete(id);
                resolvedOutagesList.push(outage);
                logger.info(`✅ Storing opgelost: ${id} in ${getCityFromOutage(outage)}`);
            }
        }

        // 3. Opruimen van oude resolved storingen (> 24 uur)
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const [id, outage] of this.resolvedOutages) {
            if (new Date(outage._resolvedAt).getTime() < cutoff) {
                this.resolvedOutages.delete(id);
            }
        }

        return { newOutages, resolvedOutages: resolvedOutagesList, updatedOutages };
    }

    /**
     * Persisteer state na verwerking (aangeroepen vanuit pollOutages).
     */
    persistState() {
        this._saveState();
    }

    /**
     * Classificeer de ernst van een storing op basis van getroffen huishoudens.
     */
    _classifySeverity(outage) {
        const households = outage.impact?.households || 0;
        let severity;

        // Aangepaste drempels voor betere nauwkeurigheid
        if (households >= 3000) {
            severity = SEVERITY.CRITICAL;
        } else if (households >= 50) {
            severity = SEVERITY.MAJOR;
        } else {
            severity = SEVERITY.MINOR; // < 50 huishoudens is nu Klein
        }

        return {
            level: severity,
            ...SEVERITY_CONFIG[severity],
        };
    }

    /**
     * Verrijk een storing met severity, stad, provincie, etc.
     */
    _enrichOutage(outage) {
        const severity = this._classifySeverity(outage);
        const city = getCityFromOutage(outage);
        const province = getProvinceFromOutage(outage);
        const postcode = outage?.location?.features?.properties?.postalCode || '';

        // Cap budgets aan maximum
        severity.googleBudget = Math.min(severity.googleBudget, this.maxDailyBudgetGoogle);
        severity.metaBudget = Math.min(severity.metaBudget, this.maxDailyBudgetMeta);

        return {
            ...outage,
            _severity: severity,
            _city: city,
            _province: province,
            _postcode: postcode,
            _campaignEndTime: new Date(
                Date.now() + this.campaignDurationHours * 60 * 60 * 1000
            ).toISOString(),
        };
    }

    /**
     * Registreer een campagne-koppeling voor een storing.
     */
    registerCampaign(outageId, platform, campaignData) {
        if (!this.campaigns.has(outageId)) {
            this.campaigns.set(outageId, { google: null, meta: null });
        }

        const outage = this.activeOutages.get(outageId);
        const budget = outage?._severity?.[`${platform}Budget`] || 0;

        this.campaigns.get(outageId)[platform] = {
            ...campaignData,
            budget,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(
                Date.now() + this.campaignDurationHours * 60 * 60 * 1000
            ).toISOString(),
            status: 'active',
        };
    }

    /**
     * Controleer of er nog budget is voor een nieuwe campagne op een bepaald platform.
     */
    canCreateNewCampaign(platform, requestedBudget) {
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;

        let totalSpent = 0;
        const maxTotalBudget = platform === 'google' ? this.totalMaxDailyBudgetGoogle : this.totalMaxDailyBudgetMeta;

        for (const [outageId, platforms] of this.campaigns) {
            const campaign = platforms[platform];
            // Getal is "budget" dat we bij registerCampaign hebben opgeslagen
            if (campaign && campaign.status === 'active' && new Date(campaign.createdAt).getTime() > oneDayAgo) {
                totalSpent += campaign.budget || 0;
            }
        }

        const canAfford = (totalSpent + requestedBudget) <= maxTotalBudget;
        if (!canAfford) {
            logger.warn(`💰 Budget limiet bereikt voor ${platform}: verbruikt €${totalSpent}, gevraagd €${requestedBudget}, limiet €${maxTotalBudget}`);
        }
        return canAfford;
    }

    /**
     * Geeft alle campagnes terug die verlopen zijn (ouder dan CAMPAIGN_DURATION_HOURS).
     */
    getExpiredCampaigns() {
        const now = Date.now();
        const expired = [];

        for (const [outageId, platforms] of this.campaigns) {
            for (const [platform, campaign] of Object.entries(platforms)) {
                if (
                    campaign &&
                    campaign.status === 'active' &&
                    new Date(campaign.expiresAt).getTime() < now
                ) {
                    expired.push({ outageId, platform, campaign });
                }
            }
        }

        return expired;
    }

    /**
     * Markeer een campagne als gepauzeerd.
     */
    markCampaignPaused(outageId, platform) {
        const campaigns = this.campaigns.get(outageId);
        if (campaigns && campaigns[platform]) {
            campaigns[platform].status = 'paused';
        }
    }

    /**
     * Geef campagne-info voor een specifieke storing.
     */
    getCampaignsForOutage(outageId) {
        return this.campaigns.get(outageId) || null;
    }

    /**
     * Haal alle actieve campagnes op voor het dashboard.
     */
    getAllCampaigns() {
        const result = [];
        for (const [outageId, platforms] of this.campaigns) {
            const outage = this.activeOutages.get(outageId) || this.resolvedOutages.get(outageId);
            result.push({
                outageId,
                city: outage ? getCityFromOutage(outage) : 'Onbekend',
                google: platforms.google,
                meta: platforms.meta,
            });
        }
        return result;
    }

    /**
     * Dashboard stats.
     */
    getStats() {
        let activeCampaigns = 0;
        for (const [, platforms] of this.campaigns) {
            if (platforms.google?.status === 'active') activeCampaigns++;
            if (platforms.meta?.status === 'active') activeCampaigns++;
        }

        return {
            activeOutages: this.activeOutages.size,
            resolvedOutages: this.resolvedOutages.size,
            totalCampaigns: this.campaigns.size,
            activeCampaigns,
        };
    }

    /**
     * Alle actieve storingen als array (voor dashboard).
     */
    getActiveOutages() {
        return Array.from(this.activeOutages.values());
    }

    /**
     * Alle opgeloste storingen als array (voor dashboard).
     */
    getResolvedOutages() {
        return Array.from(this.resolvedOutages.values());
    }
}

export { SEVERITY, SEVERITY_CONFIG };
export default OutageService;
