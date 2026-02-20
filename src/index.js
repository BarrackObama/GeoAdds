import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import ScraperService from './services/scraper-service.js';
import OutageService from './services/outage-service.js';
import GoogleAdsService from './services/google-ads-service.js';
import MetaAdsService from './services/meta-ads-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ──────────────────────────────────────
//  Services initialiseren
// ──────────────────────────────────────

const scraperService = new ScraperService();
const outageService = new OutageService();
const googleAdsService = new GoogleAdsService();
const metaAdsService = new MetaAdsService();

// ──────────────────────────────────────
//  Event log helper
// ──────────────────────────────────────

function addLogEntry(type, message, data = {}) {
    outageService.addEvent(type, message, data);
}

// ──────────────────────────────────────
//  Polling orchestratie
// ──────────────────────────────────────

let pollCount = 0;
let lastPollTime = null;
let isPolling = false;

async function pollOutages() {
    if (isPolling) {
        logger.warn('Poll wordt overgeslagen — vorige poll is nog bezig');
        return { skipped: true };
    }

    isPolling = true;
    const startTime = Date.now();

    try {
        pollCount++;
        logger.info(`📡 Poll #${pollCount} gestart...`);
        addLogEntry('poll_start', `Poll #${pollCount} gestart`);

        // 1. Haal verse storingsdata op
        const freshOutages = await scraperService.fetchOutages();

        // null = fout bij ophalen — behoud huidige state
        if (freshOutages === null) {
            logger.warn('⚠️  Storingsdata kon niet opgehaald worden — huidige state behouden');
            addLogEntry('poll_error', 'Data ophalen mislukt — state behouden');
            const duration = Date.now() - startTime;
            lastPollTime = new Date().toISOString();
            return { poll: pollCount, duration: `${duration}ms`, skipped: true, reason: 'fetch_failed' };
        }

        addLogEntry('scrape_result', `${freshOutages.length} storingen opgehaald`);

        // 2. Verwerk en vergelijk met bekende staat
        const { newOutages, resolvedOutages, updatedOutages } =
            outageService.processOutages(freshOutages);

        // 3. Voor elke NIEUWE storing → maak campagnes aan (alleen elektriciteit)
        for (const outage of newOutages) {
            const isGas = outage.network?.type === 'gas';
            addLogEntry('new_outage', `Nieuwe storing in ${outage._city}${isGas ? ' (gas)' : ''}`, {
                id: outage.id,
                city: outage._city,
                severity: outage._severity?.label,
                households: outage.impact?.households,
                networkType: outage.network?.type,
            });

            // Sla campagne-aanmaak over voor gas-storingen
            if (isGas) {
                logger.info(`⛽ Gas-storing in ${outage._city} — geen campagne aangemaakt`);
                addLogEntry('new_outage', `Gas-storing overgeslagen voor campagnes: ${outage._city}`, { id: outage.id });
                continue;
            }

            // Alleen logging van nieuwe storingen, campagnes zijn nu handmatig
            logger.info(
                `🆕 Nieuwe storing gedetecteerd: ${outage.id} in ${outage._city} ` +
                `(${outage._severity.label}, ${outage.impact?.households || 0} huishoudens)`
            );
        }

        // 4. Opgeloste storingen → direct campagnes pauzeren
        for (const outage of resolvedOutages) {
            addLogEntry('outage_resolved', `Storing opgelost in ${outage._city || 'Onbekend'}`, {
                id: outage.id,
            });

            // Pauzeer actieve campagnes voor deze storing
            const campaigns = outageService.getCampaignsForOutage(outage.id);
            if (campaigns) {
                if (campaigns.google?.status === 'active' && campaigns.google.campaignResourceName) {
                    try {
                        const success = await googleAdsService.pauseCampaign(campaigns.google.campaignResourceName);
                        if (success) {
                            outageService.markCampaignPaused(outage.id, 'google');
                            addLogEntry('campaign_paused', `Google Ads campagne gepauzeerd (storing opgelost)`, { outageId: outage.id });
                        }
                    } catch (e) {
                        logger.error(`Fout bij pauzeren Google campagne voor ${outage.id}: ${e.message}`);
                    }
                }
                if (campaigns.meta?.status === 'active' && campaigns.meta.campaignId) {
                    try {
                        const success = await metaAdsService.pauseCampaign(campaigns.meta.campaignId);
                        if (success) {
                            outageService.markCampaignPaused(outage.id, 'meta');
                            addLogEntry('campaign_paused', `Meta Ads campagne gepauzeerd (storing opgelost)`, { outageId: outage.id });
                        }
                    } catch (e) {
                        logger.error(`Fout bij pauzeren Meta campagne voor ${outage.id}: ${e.message}`);
                    }
                }
            }
        }

        // 5. Persisteer state naar disk
        outageService.persistState();

        const duration = Date.now() - startTime;
        lastPollTime = new Date().toISOString();

        const result = {
            poll: pollCount,
            duration: `${duration}ms`,
            outagesFound: freshOutages.length,
            newOutages: newOutages.length,
            resolvedOutages: resolvedOutages.length,
            updatedOutages: updatedOutages.length,
        };

        logger.info(
            `📡 Poll #${pollCount} voltooid in ${duration}ms — ` +
            `${freshOutages.length} storingen, ${newOutages.length} nieuw, ${resolvedOutages.length} opgelost`
        );
        addLogEntry('poll_complete', `Poll #${pollCount} voltooid`, result);

        return result;
    } catch (error) {
        logger.error(`Poll #${pollCount} mislukt: ${error.message}`);
        addLogEntry('poll_error', `Poll mislukt: ${error.message}`);
        return { error: error.message };
    } finally {
        isPolling = false;
    }
}

// ──────────────────────────────────────
//  Dagelijkse cleanup: verlopen campagnes pauzeren
// ──────────────────────────────────────

async function cleanupExpiredCampaigns() {
    logger.info('🧹 Dagelijkse cleanup: verlopen campagnes controleren...');
    const expired = outageService.getExpiredCampaigns();

    if (expired.length === 0) {
        logger.info('🧹 Geen verlopen campagnes gevonden');
        return;
    }

    for (const { outageId, platform, campaign } of expired) {
        try {
            let success = false;

            if (platform === 'google' && campaign.campaignResourceName) {
                success = await googleAdsService.pauseCampaign(campaign.campaignResourceName);
            } else if (platform === 'meta' && campaign.campaignId) {
                success = await metaAdsService.pauseCampaign(campaign.campaignId);
            }

            if (success) {
                outageService.markCampaignPaused(outageId, platform);
                addLogEntry('campaign_paused', `${platform} campagne gepauzeerd (verlopen)`, {
                    outageId,
                    platform,
                });
            }
        } catch (error) {
            logger.error(`Cleanup fout voor ${platform} campagne: ${error.message}`);
        }
    }

    logger.info(`🧹 Cleanup voltooid: ${expired.length} campagnes gecontroleerd`);
}

// ──────────────────────────────────────
//  Express API
// ──────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

// Systeem status + stats
app.get('/api/status', (req, res) => {
    const stats = outageService.getStats();
    res.json({
        status: 'running',
        uptime: Math.round(process.uptime()),
        pollCount,
        lastPollTime,
        dataSourceMode: process.env.DATA_SOURCE_MODE || 'scrape',
        simulationMode: process.env.SIMULATION_MODE === 'true',
        services: {
            enabled: googleAdsService.isEnabled() || metaAdsService.isEnabled(),
            google: googleAdsService.isEnabled(),
            meta: metaAdsService.isEnabled(),
        },
        stats,
        timestamp: new Date().toISOString(),
    });
});

// Actieve en recent opgeloste storingen
app.get('/api/outages', (req, res) => {
    res.json({
        active: outageService.getActiveOutages().map(sanitizeOutage),
        resolved: outageService.getResolvedOutages().map(sanitizeOutage),
    });
});

// Alle campagnes
app.get('/api/campaigns', (req, res) => {
    res.json({
        campaigns: outageService.getAllCampaigns(),
    });
});

// Event log
app.get('/api/log', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    res.json({
        total: outageService.eventLog.length,
        entries: outageService.eventLog.slice(0, limit),
    });
});

/**
 * Handle manual campaign creation
 */
app.post('/api/campaigns/create', async (req, res) => {
    const { outageId, customBudget, customRadius, customDuration, platforms } = req.body;
    if (!outageId) {
        return res.status(400).json({ error: 'outageId is verplicht' });
    }

    const outage = outageService.activeOutages.get(outageId);
    if (!outage) {
        return res.status(404).json({ error: 'Storing niet gevonden of al opgelost' });
    }

    const results = { google: null, meta: null };
    const errors = [];

    addLogEntry('manual_campaign_trigger', `Handmatige campagne activatie gestart voor ${outage._city}`, { id: outageId });

    // Google Ads
    if (googleAdsService.isEnabled() && (!platforms || platforms.includes('google'))) {
        const requestedBudget = customBudget || outage._severity?.googleBudget || 0;
        if (outageService.canCreateNewCampaign('google', requestedBudget)) {
            try {
                const googleCampaign = await googleAdsService.createCampaign(outage, {
                    customBudget: customBudget,
                    customRadius: customRadius,
                    customDuration: customDuration
                });
                if (googleCampaign) {
                    outageService.registerCampaign(outageId, 'google', googleCampaign);
                    results.google = googleCampaign;
                    addLogEntry('campaign_created', `Google Ads campagne handmatig aangemaakt voor ${outage._city}`, { id: outageId, simulated: googleCampaign.simulated });
                }
            } catch (err) {
                errors.push(`Google Ads: ${err.message}`);
                addLogEntry('campaign_error', `Google Ads fout (handmatig) voor ${outage._city}: ${err.message}`);
            }
        } else {
            errors.push('Google Ads: Dagelijks budget limiet bereikt');
            addLogEntry('campaign_skipped', `Google Ads overgeslagen (budget limiet/handmatig) voor ${outage._city}`, { id: outageId });
        }
    }

    // Meta Ads
    if (metaAdsService.isEnabled() && (!platforms || platforms.includes('meta'))) {
        const requestedBudget = customBudget || outage._severity?.metaBudget || 0;
        if (outageService.canCreateNewCampaign('meta', requestedBudget)) {
            try {
                const metaCampaign = await metaAdsService.createCampaign(outage, {
                    customBudget: customBudget,
                    customRadius: customRadius,
                    customDuration: customDuration
                });
                if (metaCampaign) {
                    outageService.registerCampaign(outageId, 'meta', metaCampaign);
                    results.meta = metaCampaign;
                    addLogEntry('campaign_created', `Meta Ads campagne handmatig aangemaakt voor ${outage._city}`, { id: outageId, simulated: metaCampaign.simulated });
                }
            } catch (err) {
                errors.push(`Meta Ads: ${err.message}`);
                addLogEntry('campaign_error', `Meta Ads fout (handmatig) voor ${outage._city}: ${err.message}`);
            }
        } else {
            errors.push('Meta Ads: Dagelijks budget limiet bereikt');
            addLogEntry('campaign_skipped', `Meta Ads overgeslagen (budget limiet/handmatig) voor ${outage._city}`, { id: outageId });
        }
    }

    if (!results.google && !results.meta && errors.length > 0) {
        return res.status(500).json({ error: 'Campagne aanmaak mislukt', details: errors });
    }

    res.json({ message: 'Campagne(s) succesvol aangemaakt', results });
});

// Handmatige poll trigger
app.post('/api/poll', async (req, res) => {
    try {
        addLogEntry('manual_poll', 'Handmatige poll gestart');
        const result = await pollOutages();
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Verwijder interne velden (_raw, etc.) uit de response.
 */
function sanitizeOutage(outage) {
    const { _raw, ...clean } = outage;
    return clean;
}

// ──────────────────────────────────────
//  Server starten
// ──────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '900000', 10);
const POLL_INTERVAL_MINUTES = Math.max(1, Math.round(POLL_INTERVAL_MS / 60000));

app.listen(PORT, () => {
    logger.info('═══════════════════════════════════════════════════');
    logger.info('  🔋 Offgrid Storings-Tracker gestart');
    logger.info(`  📡 API: http://localhost:${PORT}`);
    logger.info(`  ⏱️  Poll-interval: elke ${POLL_INTERVAL_MINUTES} minuten`);
    logger.info(`  📊 Data-bron: ${process.env.DATA_SOURCE_MODE || 'scrape'}`);
    logger.info(`  🔍 Google Ads: ${googleAdsService.isEnabled() ? '✅ actief' : '❌ niet geconfigureerd'}`);
    logger.info(`  📘 Meta Ads: ${metaAdsService.isEnabled() ? '✅ actief' : '❌ niet geconfigureerd'}`);
    logger.info('═══════════════════════════════════════════════════');

    addLogEntry('system_start', 'Offgrid Storings-Tracker gestart', {
        port: PORT,
        pollInterval: POLL_INTERVAL_MS,
        dataSourceMode: process.env.DATA_SOURCE_MODE || 'scrape',
    });

    // Eerste poll na 5 seconden
    setTimeout(() => {
        pollOutages().catch((err) => logger.error(`Eerste poll mislukt: ${err.message}`));
    }, 5000);

    // Periodieke polling via cron
    // Converteer interval naar cron-expressie (elke N minuten)
    const cronExpression = `*/${POLL_INTERVAL_MINUTES} * * * *`;
    cron.schedule(cronExpression, () => {
        pollOutages().catch((err) => logger.error(`Geplande poll mislukt: ${err.message}`));
    });

    // Dagelijkse cleanup om 03:00 's nachts
    cron.schedule('0 3 * * *', () => {
        cleanupExpiredCampaigns().catch((err) =>
            logger.error(`Dagelijkse cleanup mislukt: ${err.message}`)
        );
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Systeem wordt afgesloten...');
    await scraperService.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Systeem wordt afgesloten...');
    await scraperService.close();
    process.exit(0);
});

// Onverwachte fouten opvangen (voorkom crash)
process.on('uncaughtException', (error) => {
    logger.error('Onverwachte fout (uncaughtException):', error);
    addLogEntry('error', `Onverwachte fout: ${error.message}`);
});

process.on('unhandledRejection', (reason) => {
    logger.error('Onafgehandelde rejection:', reason);
    addLogEntry('error', `Onafgehandelde rejection: ${reason}`);
});
