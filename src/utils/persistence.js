import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', '..', 'data');

// Zorg dat de data directory bestaat
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Sla data op als JSON naar data/<key>.json
 * @param {string} key - bestandsnaam (zonder extensie)
 * @param {any} data - data om op te slaan
 */
export function save(key, data) {
    try {
        const filePath = path.join(dataDir, `${key}.json`);
        const tmpPath = `${filePath}.tmp`;
        // Schrijf naar tmp eerst, dan rename (atomic write)
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpPath, filePath);
        logger.debug(`Persistence: ${key} opgeslagen (${filePath})`);
    } catch (error) {
        logger.error(`Persistence: fout bij opslaan ${key}: ${error.message}`);
    }
}

/**
 * Laad data uit data/<key>.json
 * @param {string} key - bestandsnaam (zonder extensie)
 * @param {any} defaultValue - standaardwaarde als bestand niet bestaat
 * @returns {any} geladen data of defaultValue
 */
export function load(key, defaultValue = null) {
    try {
        const filePath = path.join(dataDir, `${key}.json`);
        if (!fs.existsSync(filePath)) {
            logger.debug(`Persistence: ${key} niet gevonden, gebruik standaard`);
            return defaultValue;
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        logger.info(`Persistence: ${key} geladen`);
        return data;
    } catch (error) {
        logger.error(`Persistence: fout bij laden ${key}: ${error.message}`);
        return defaultValue;
    }
}

export default { save, load };
