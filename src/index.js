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
//  Event log (in-memory, max 200)
// ──────────────────────────────────────

const MAX_LOG_ENTRIES = 200;
const eventLog = [];

function addLogEntry(type, message, data = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        type,
        message,
        data,
    };
    eventLog.unshift(entry); // Nieuwste eerst
    if (eventLog.length > MAX_LOG_ENTRIES) {
        eventLog.length = MAX_LOG_ENTRIES;
    }
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
        addLogEntry('scrape_result', `${freshOutages.length} storingen opgehaald`);

        // 2. Verwerk en vergelijk met bekende staat
        const { newOutages, resolvedOutages, updatedOutages } =
            outageService.processOutages(freshOutages);

        // 3. Voor elke NIEUWE storing → maak campagnes aan
        for (const outage of newOutages) {
            addLogEntry('new_outage', `Nieuwe storing in ${outage._city}`, {
                id: outage.id,
                city: outage._city,
                severity: outage._severity?.label,
                households: outage.impact?.households,
            });

            // Google Ads campagne
            try {
                const googleCampaign = await googleAdsService.createCampaign(outage);
                if (googleCampaign) {
                    outageService.registerCampaign(outage.id, 'google', googleCampaign);
                    addLogEntry('campaign_created', `Google Ads campagne aangemaakt voor ${outage._city}`, googleCampaign);
                }
            } catch (error) {
                logger.error(`Fout bij Google Ads campagne voor ${outage.id}: ${error.message}`);
                addLogEntry('campaign_error', `Google Ads fout: ${error.message}`, { outageId: outage.id });
            }

            // Meta Ads campagne
            try {
                const metaCampaign = await metaAdsService.createCampaign(outage);
                if (metaCampaign) {
                    outageService.registerCampaign(outage.id, 'meta', metaCampaign);
                    addLogEntry('campaign_created', `Meta Ads campagne aangemaakt voor ${outage._city}`, metaCampaign);
                }
            } catch (error) {
                logger.error(`Fout bij Meta Ads campagne voor ${outage.id}: ${error.message}`);
                addLogEntry('campaign_error', `Meta Ads fout: ${error.message}`, { outageId: outage.id });
            }
        }

        // 4. Log opgeloste storingen (campagnes lopen nog 72u door)
        for (const outage of resolvedOutages) {
            addLogEntry('outage_resolved', `Storing opgelost in ${outage._city || 'Onbekend'}`, {
                id: outage.id,
                note: 'Campagnes draaien nog door tot de einddatum',
            });
        }

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
        services: {
            googleAds: googleAdsService.isEnabled() ? 'geconfigureerd' : 'niet geconfigureerd',
            metaAds: metaAdsService.isEnabled() ? 'geconfigureerd' : 'niet geconfigureerd',
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
    const limit = Math.min(parseInt(req.query.limit || '50', 10), MAX_LOG_ENTRIES);
    res.json({
        total: eventLog.length,
        entries: eventLog.slice(0, limit),
    });
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
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '120000', 10);
const POLL_INTERVAL_MINUTES = Math.max(1, Math.round(POLL_INTERVAL_MS / 60000));

app.listen(PORT, () => {
    logger.info('═══════════════════════════════════════════════════');
    logger.info('  🔋 Offgrid Storings-Tracker gestart');
    logger.info(`  📡 API: http://localhost:${PORT}`);
    logger.info(`  ⏱️  Poll-interval: elke ${POLL_INTERVAL_MINUTES} minuut`);
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
