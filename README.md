# 🔋 Offgrid Storings-Tracker

Automatische storings-tracker die live stroomstoringen in Nederland detecteert en direct geo-getargete Google Ads en Meta/Facebook Ads campagnes activeert voor Offgridcentrum.

## Hoe werkt het?

1. **Detectie** — Het systeem pollt elke 2 minuten storingsdata van energieonderbrekingen.nl
2. **Classificatie** — Nieuwe storingen worden geclassificeerd op ernst (klein/groot/kritiek)
3. **Campagnes** — Automatisch worden Google Ads en Meta Ads campagnes aangemaakt met geo-targeting rondom het storingsgebied
4. **Auto-stop** — Campagnes worden automatisch gepauzeerd na 72 uur of wanneer de storing is opgelost

## Installatie

```bash
# Kloon de repository
git clone <repository-url>
cd offgrid-storings-tracker

# Installeer dependencies
npm install

# Installeer Playwright browser (voor scraping modus)
npx playwright install chromium

# Kopieer de environment variabelen
cp .env.example .env
# → Vul de credentials in (zie hieronder)

# Start de applicatie
npm run dev
```

## Configuratie

### Databron instellen

De applicatie ondersteunt 3 modi voor het ophalen van storingsdata:

| Modus | `.env` waarde | Beschrijving |
|-------|---------------|--------------|
| **API** | `DATA_SOURCE_MODE=api` | Haalt data op via de energieonderbrekingen.nl API (vereist Auth0 credentials) |
| **Scraping** | `DATA_SOURCE_MODE=scrape` | Scrapt de website met een headless browser (standaard) |
| **Hybrid** | `DATA_SOURCE_MODE=hybrid` | Probeert API eerst, valt terug op scraping |

### Google Ads instellen

```bash
npm run setup:google
```

Dit interactieve script leidt je door het OAuth2 setup proces.

### Meta Ads instellen

```bash
npm run setup:meta
```

Dit script toont de stappen om Meta Ads API credentials te verkrijgen.

### Connecties testen

```bash
npm run test:connections
```

Test alle externe connecties en rapporteert de status.

## API Endpoints

De applicatie biedt een REST API voor het dashboard:

| Methode | Pad | Beschrijving |
|---------|-----|--------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/status` | Systeemstatus en statistieken |
| `GET` | `/api/outages` | Actieve en recent opgeloste storingen |
| `GET` | `/api/campaigns` | Alle Google + Meta campagnes |
| `GET` | `/api/log` | Event log (max 200 entries) |
| `POST` | `/api/poll` | Handmatige poll trigger |

## Ernst-classificatie

| Ernst | Huishoudens | Google Ads | Meta Ads | Radius |
|-------|-------------|------------|----------|--------|
| Klein | < 1.000 | €15/dag | €12/dag | 5 km |
| Groot | 1.000 – 3.000 | €35/dag | €30/dag | 10 km |
| Kritiek | > 3.000 | €60/dag | €50/dag | 15 km |

## Projectstructuur

```
offgrid-storings-tracker/
├── src/
│   ├── index.js                     # Express API, polling, orchestratie
│   ├── services/
│   │   ├── scraper-service.js       # Storingsdata ophalen
│   │   ├── outage-service.js        # Detectie, classificatie, state
│   │   ├── google-ads-service.js    # Google Ads automatisering
│   │   └── meta-ads-service.js      # Meta Ads automatisering
│   └── utils/
│       ├── logger.js                # Winston logging
│       ├── postcode-utils.js        # Postcode → provincie mapping
│       ├── google-auth-setup.js     # Google OAuth setup helper
│       ├── meta-auth-setup.js       # Meta setup instructies
│       └── test-connections.js      # Connectie test
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Technische vereisten

- **Node.js** 20 of hoger
- **Playwright** (voor scraping modus)

## Licentie

Intern gebruik — Offgridcentrum
