/**
 * Postcode → Provincie mapping voor Nederland.
 * Gebaseerd op de eerste 2 cijfers van de postcode.
 */

const PROVINCIE_RANGES = [
    { min: 10, max: 20, provincie: 'Noord-Holland' },
    { min: 21, max: 29, provincie: 'Zuid-Holland' },
    { min: 30, max: 39, provincie: 'Utrecht' },
    { min: 40, max: 46, provincie: 'Zeeland' },
    { min: 47, max: 59, provincie: 'Noord-Brabant' },
    { min: 60, max: 65, provincie: 'Limburg' },
    { min: 66, max: 76, provincie: 'Gelderland' },
    { min: 77, max: 84, provincie: 'Overijssel' },
    { min: 85, max: 86, provincie: 'Flevoland' },
    { min: 87, max: 95, provincie: 'Friesland' },
    { min: 96, max: 99, provincie: 'Groningen' },
];

/**
 * Bepaal de provincie op basis van een Nederlandse postcode.
 * @param {string} postcode – bijv. "4321AB" of "4321"
 * @returns {string|null} Provincienaam of null als niet gevonden
 */
export function getProvince(postcode) {
    if (!postcode) return null;
    const prefix = parseInt(String(postcode).replace(/\D/g, '').substring(0, 2), 10);
    if (isNaN(prefix)) return null;
    const match = PROVINCIE_RANGES.find((r) => prefix >= r.min && prefix <= r.max);
    return match ? match.provincie : null;
}

/**
 * Splits een puntkomma-gescheiden postcode-string naar array.
 * @param {string} postcodeString – bijv. "4321AB;4321AC;4322BA"
 * @returns {string[]}
 */
export function parsePostcodes(postcodeString) {
    if (!postcodeString) return [];
    return postcodeString
        .split(';')
        .map((pc) => pc.trim())
        .filter(Boolean);
}

/**
 * Haal de stad uit de locatiedata van een storing.
 * @param {object} outage – storingsdata
 * @returns {string}
 */
export function getCityFromOutage(outage) {
    try {
        return outage?.location?.features?.properties?.city || 'Onbekend';
    } catch {
        return 'Onbekend';
    }
}

/**
 * Haal de provincie uit de locatiedata van een storing.
 * @param {object} outage – storingsdata
 * @returns {string|null}
 */
export function getProvinceFromOutage(outage) {
    const postcodes = parsePostcodes(
        outage?.location?.features?.properties?.postalCode
    );
    if (postcodes.length === 0) return null;
    return getProvince(postcodes[0]);
}
