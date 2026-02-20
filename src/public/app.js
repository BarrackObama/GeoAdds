// ── Config ───────────────────────────────
const API_BASE = '';  // same origin
const REFRESH_INTERVAL = 900000; // 15 minutes
const NOTIFICATION_THRESHOLD = 500; // Households
let notifiedOutages = new Set(); // Track notified IDs in memory

// ── Fetch helpers ────────────────────────
async function fetchJSON(endpoint) {
    try {
        const res = await fetch(`${API_BASE}${endpoint}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        console.error(`Fetch ${endpoint} failed:`, err);
        return null;
    }
}

// ── Format helpers ───────────────────────
function formatUptime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}u ${m}m`;
}

function formatTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleString('nl-NL', {
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function getLogBadgeClass(type) {
    if (type.includes('poll')) return 'poll';
    if (type.includes('outage') || type.includes('scrape') || type.includes('campaign_skipped')) return 'outage';
    if (type.includes('campaign')) return 'campaign';
    if (type.includes('error')) return 'error';
    return 'system';
}

function getLogBadgeLabel(type) {
    const map = {
        'poll_start': 'Poll',
        'poll_complete': 'Poll',
        'poll_error': 'Fout',
        'scrape_result': 'Scrape',
        'new_outage': 'Storing',
        'outage_resolved': 'Opgelost',
        'campaign_created': 'Campagne',
        'campaign_paused': 'Campagne',
        'campaign_skipped': 'Skip',
        'campaign_error': 'Fout',
        'system_start': 'Systeem',
        'manual_poll': 'Poll',
        'error': 'Fout',
    };
    return map[type] || type;
}

// ── Notification helper ──────────────────
async function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
        await Notification.requestPermission();
    }
}

function sendOutageNotification(outage) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const city = outage._city || 'Onbekend';
    const households = outage.impact?.households || 0;

    new Notification("🚨 Grote Storing Gedetecteerd!", {
        body: `Stroomstoring in ${city} treft ${households} huishoudens. Bekijk het dashboard voor actie.`,
        icon: '/favicon.ico' // Or any relevant icon
    });
}

// ── Update functions ─────────────────────
async function updateStatus() {
    const data = await fetchJSON('/api/status');
    if (!data) return;

    document.getElementById('statUptime').textContent = formatUptime(data.uptime);
    document.getElementById('statUptimeSub').textContent = `Sinds ${formatTime(data.timestamp)}`;

    document.getElementById('statPolls').textContent = data.pollCount;
    document.getElementById('statPollsSub').textContent = data.lastPollTime
        ? `Laatste: ${formatTime(data.lastPollTime)}`
        : 'Nog niet gepolld';

    document.getElementById('statOutages').textContent = data.stats?.activeOutages ?? 0;
    document.getElementById('statOutagesSub').textContent =
        `${data.stats?.resolvedOutages ?? 0} opgelost`;

    document.getElementById('statCampaigns').textContent = data.stats?.activeCampaigns ?? 0;
    document.getElementById('statCampaignsSub').textContent =
        `${data.stats?.totalCampaigns ?? 0} totaal`;

    const mode = data.dataSourceMode || 'scrape';
    document.getElementById('statMode').textContent = mode.toUpperCase();
    document.getElementById('statModeSub').textContent =
        mode === 'api' ? 'Via API' : mode === 'scrape' ? 'Via browser scraping' : 'API + fallback';

    // Services
    const gSvc = document.getElementById('svcGoogle');
    const mSvc = document.getElementById('svcMeta');

    if (gSvc) {
        gSvc.className = `service-status ${data.services.google ? 'active' : 'inactive'}`;
        gSvc.textContent = data.services.google ? 'Actief' : 'Niet geconfigureerd';
    }

    if (mSvc) {
        mSvc.className = `service-status ${data.services.meta ? 'active' : 'inactive'}`;
        mSvc.textContent = data.services.meta ? 'Actief' : 'Niet geconfigureerd';
    }

    // Simulation Banner
    const banner = document.getElementById('simulation-banner');
    if (banner) {
        banner.style.display = data.simulationMode ? 'block' : 'none';
    }
}

async function updateOutages() {
    const data = await fetchJSON('/api/outages');
    if (!data) return;

    const container = document.getElementById('outagesList');
    const countEl = document.getElementById('outageCount');
    const active = data.active || [];
    const resolved = data.resolved || [];

    countEl.textContent = `${active.length} actief · ${resolved.length} opgelost`;

    if (active.length === 0 && resolved.length === 0) {
        container.innerHTML = `
        <div class="empty-state">
            <div class="icon">✅</div>
            <p>Geen actieve storingen gevonden</p>
        </div>`;
        return;
    }

    let html = '';
    for (const o of active) {
        const sev = o._severity?.label || 'onbekend';
        const streetRaw = o.location?.features?.properties?.street || '';
        const street = streetRaw.replace(/;/g, ', ');
        const msg = o.message || '';
        const postcodesRaw = o._postcode || '';
        const pcList = postcodesRaw.split(';').filter(Boolean);
        const pcSummary = pcList.length > 1 ? `${pcList[0]} + ${pcList.length - 1}` : (pcList[0] || '');
        const isGas = o.network?.type === 'gas';
        const typeIcon = isGas ? '🔥' : '⚡';
        const typeLabel = isGas ? 'Gas' : 'Elektriciteit';

        // Use the original label from the energy company (e.g. "< 25", "< 1.000")
        let householdLabel = '';
        if (o._affectedLabel) {
            householdLabel = `${escapeHtml(o._affectedLabel)} huishoudens`;
        } else if (o.impact?.households) {
            const prefix = o.impact.max ? '< ' : (o.impact.min ? '> ' : '');
            householdLabel = `${prefix}${o.impact.households} huishoudens`;
        }

        const isHighImpact = (o.impact?.households || 0) >= NOTIFICATION_THRESHOLD;

        // Notify if new and high impact
        if (isHighImpact && !notifiedOutages.has(o.id)) {
            sendOutageNotification(o);
            notifiedOutages.add(o.id);
        }

        html += `
        <div class="outage-item ${isHighImpact ? 'high-impact' : ''}" onclick="toggleOutageDetail(this)">
            <div class="outage-main">
                <div class="outage-severity ${sev.toLowerCase()}"></div>
                <div class="outage-details">
                    <div class="outage-city">${escapeHtml(o._city || o.id)}</div>
                    <div class="outage-meta">
                        <span>${typeIcon} ${typeLabel} · ${sev}</span>
                        ${householdLabel ? `<span>🏠 ${householdLabel}</span>` : ''}
                        ${pcSummary ? `<span>📍 ${escapeHtml(pcSummary)}</span>` : ''}
                    </div>
                </div>
                <div class="outage-expand-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
            </div>
            <div class="outage-details-extra">
                <div class="manual-action">
                    <button class="btn btn-action" onclick="event.stopPropagation(); createManualCampaign('${o.id}')">
                        🚀 Start Campagne
                    </button>
                    <button class="options-toggle" onclick="event.stopPropagation(); toggleOptions('${o.id}')">
                        Instellingen aanpassen
                    </button>
                </div>
                
                <div id="options-${o.id}" class="campaign-options" style="display: none;" onclick="event.stopPropagation()">
                    <div class="options-grid">
                        <div class="option-field">
                            <label>Budget (€/dag)</label>
                            <input type="number" id="budget-${o.id}" value="${o._severity?.googleBudget || 15}" min="5" max="500">
                        </div>
                        <div class="option-field">
                            <label>Radius (km)</label>
                            <input type="number" id="radius-${o.id}" value="${o._severity?.radiusKm || 5}" min="1" max="50">
                        </div>
                        <div class="option-field">
                            <label>Duur (dagen)</label>
                            <input type="number" id="duration-${o.id}" value="3" min="1" max="14">
                        </div>
                    </div>
                    <div class="platforms-selection">
                        <label class="platform-checkbox">
                            <input type="checkbox" id="plat-google-${o.id}" checked> Google Ads
                        </label>
                        <label class="platform-checkbox">
                            <input type="checkbox" id="plat-meta-${o.id}" checked> Meta Ads
                        </label>
                    </div>
                </div>
                ${street ? `
                    <div class="detail-row">
                        <span class="detail-label">📍 Getroffen straten</span>
                        <div class="detail-value">${escapeHtml(street)}</div>
                    </div>` : ''}
                ${pcList.length > 0 ? `
                    <div class="detail-row">
                        <span class="detail-label">📬 Postcodes</span>
                        <div class="detail-value">${escapeHtml(pcList.join(', '))}</div>
                    </div>` : ''}
                ${msg ? `
                    <div class="detail-row">
                        <span class="detail-label">📝 Bericht</span>
                        <div class="detail-value">${escapeHtml(msg)}</div>
                    </div>` : ''}
                <div class="detail-row">
                    <span class="detail-label">⏰ Begonnen</span>
                    <div class="detail-value">${formatDateTime(o.period?.begin)}</div>
                </div>
                ${o.period?.expectedEnd ? `
                    <div class="detail-row">
                        <span class="detail-label">🕒 Verwachte eindtijd</span>
                        <div class="detail-value">${formatDateTime(o.period.expectedEnd)}</div>
                    </div>` : ''}
            </div>
        </div>`;
    }
    if (resolved.length > 0) {
        html += `<div style="margin-top:12px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">
        <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:8px">Recent opgelost</div>`;
        for (const o of resolved.slice(0, 5)) {
            html += `
            <div class="outage-item" style="opacity:0.6">
                <div class="outage-severity" style="background:var(--accent-green)"></div>
                <div class="outage-details">
                    <div class="outage-city">${escapeHtml(o._city || o.id)}</div>
                    <div class="outage-meta"><span>✅ Opgelost</span></div>
                </div>
            </div>`;
        }
        html += '</div>';
    }
    container.innerHTML = html;
}

/**
 * Trigger manual campaign creation
 */
async function createManualCampaign(outageId) {
    const budgetInput = document.getElementById(`budget-${outageId}`);
    const radiusInput = document.getElementById(`radius-${outageId}`);
    const durationInput = document.getElementById(`duration-${outageId}`);
    const platGoogle = document.getElementById(`plat-google-${outageId}`);
    const platMeta = document.getElementById(`plat-meta-${outageId}`);

    const customBudget = budgetInput ? parseFloat(budgetInput.value) : null;
    const customRadius = radiusInput ? parseFloat(radiusInput.value) : null;
    const customDurationDays = durationInput ? parseInt(durationInput.value) : null;
    const customDuration = customDurationDays ? customDurationDays * 24 : null;

    const platforms = [];
    if (platGoogle && platGoogle.checked) platforms.push('google');
    if (platMeta && platMeta.checked) platforms.push('meta');

    if (platforms.length === 0) {
        alert('Selecteer minimaal één platform (Google of Meta).');
        return;
    }

    if (!confirm('Weet je zeker dat je handmatig een campagne wilt starten met deze instellingen?')) {
        return;
    }

    try {
        const res = await fetch('/api/campaigns/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                outageId,
                customBudget,
                customRadius,
                customDuration,
                platforms
            }),
        });

        const data = await res.json();
        if (!res.ok) {
            alert(`Fout: ${data.error || 'Onbekende fout'}\n${data.details ? data.details.join('\n') : ''}`);
        } else {
            alert(data.message || 'Campagne succesvol gestart!');
            refreshAll();
        }
    } catch (err) {
        console.error('Manual campaign trigger failed:', err);
        alert('Er is een fout opgetreden bij het starten van de campagne.');
    }
}

async function updateCampaigns() {
    const data = await fetchJSON('/api/campaigns');
    if (!data) return;

    const container = document.getElementById('campaignsList');
    const countEl = document.getElementById('campaignCount');
    const campaigns = data.campaigns || [];

    countEl.textContent = campaigns.length;

    if (campaigns.length === 0) {
        container.innerHTML = `
        <div class="empty-state">
            <div class="icon">📭</div>
            <p>Nog geen campagnes aangemaakt. Campagnes worden automatisch aangemaakt bij nieuwe storingen.</p>
        </div>`;
        return;
    }

    let html = '';
    for (const c of campaigns) {
        html += `
        <div class="campaign-item">
            <div class="campaign-top">
                <div class="campaign-name">${escapeHtml(c.campaignName || c.outageId || 'Campagne')}</div>
                <div class="campaign-platform ${c.platform || ''} ${c.simulated ? 'simulated' : ''}">
                    ${c.simulated ? '🧪 ' : ''}${c.platform || '?'}
                </div>
            </div>
            <div class="campaign-info">
                ${c.google?.budget ? `<span>💰 €${c.google.budget}/dag</span>` : ''}
                ${c.meta?.budget ? `<span>💰 €${c.meta.budget}/dag</span>` : ''}
                ${c.google?.status ? `<span>📊 G: ${c.google.status}</span>` : ''}
                ${c.meta?.status ? `<span>📊 M: ${c.meta.status}</span>` : ''}
            </div>
        </div>`;
    }
    container.innerHTML = html;
}

async function updateLog() {
    const data = await fetchJSON('/api/log?limit=50');
    if (!data) return;

    const container = document.getElementById('logList');
    const countEl = document.getElementById('logCount');
    const entries = data.entries || [];

    countEl.textContent = data.total;

    if (entries.length === 0) {
        container.innerHTML = `
        <div class="empty-state">
            <div class="icon">📝</div>
            <p>Nog geen events</p>
        </div>`;
        return;
    }

    let html = '';
    for (const e of entries) {
        const isSimulated = e.type === 'simulation' || (e.data && e.data.simulated);
        const time = formatTime(e.timestamp);
        const typeClass = getLogBadgeClass(e.type);
        const typeLabel = getLogBadgeLabel(e.type);

        html += `
        <div class="log-item">
            <span class="log-time">${time}</span>
            <span class="log-badge ${typeClass} ${isSimulated ? 'simulated' : ''}">${typeLabel}</span>
            <span class="log-message">${escapeHtml(e.message)}</span>
        </div>`;
    }
    container.innerHTML = html;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function toggleOutageDetail(el) {
    el.classList.toggle('expanded');
}

function toggleOptions(outageId) {
    const el = document.getElementById(`options-${outageId}`);
    if (el) {
        el.style.display = (el.style.display === 'none') ? 'flex' : 'none';
    }
}

// ── Poll trigger ─────────────────────────
async function triggerPoll() {
    const btn = document.getElementById('pollBtn');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Polling...';

    try {
        await fetch(`${API_BASE}/api/poll`, { method: 'POST' });
        await refreshAll();
    } catch (err) {
        console.error('Poll trigger failed:', err);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '📡 Poll nu';
    }
}

// ── Refresh cycle ────────────────────────
async function refreshAll() {
    await Promise.all([
        updateStatus(),
        updateOutages(),
        updateCampaigns(),
        updateLog(),
    ]);
}

// Refresh progress bar
let refreshTimer = null;
function startRefreshCycle() {
    const bar = document.getElementById('refreshBar');
    let elapsed = 0;
    const step = 1000;

    function tick() {
        elapsed += step;
        const pct = Math.min((elapsed / REFRESH_INTERVAL) * 100, 100);
        bar.style.width = `${pct}%`;

        if (elapsed >= REFRESH_INTERVAL) {
            bar.style.width = '0%';
            elapsed = 0;
            refreshAll();
        }
    }

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(tick, step);
}

// ── Init ─────────────────────────────────
requestNotificationPermission();
refreshAll();
startRefreshCycle();
