import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default data directory inside studypilot-server/data
const DATA_DIR = process.env.STUDYPILOT_DATA_DIR 
    ? path.resolve(process.cwd(), process.env.STUDYPILOT_DATA_DIR)
    : path.resolve(__dirname, "data");

const DATA_FILE = path.join(DATA_DIR, "studypilot_data.json");

/**
 * Ensures the data storage directory exists
 */
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Loads the storage database from disk
 * @returns {Record<string, any>} All stored plans keyed by planId
 */
export function loadAllPlans() {
    try {
        ensureDataDir();
        if (!fs.existsSync(DATA_FILE)) {
            return {};
        }
        const raw = fs.readFileSync(DATA_FILE, "utf-8");
        if (!raw.trim()) return {};
        return JSON.parse(raw);
    } catch (error) {
        console.error("[StudyPilot Storage] Failed to load data file:", error.message);
        return {};
    }
}

/**
 * Saves all plans to disk safely
 * @param {Record<string, any>} data
 */
export function saveAllPlans(data) {
    try {
        ensureDataDir();
        const jsonContent = JSON.stringify(data, null, 2);
        try {
            const tmpFile = `${DATA_FILE}.tmp`;
            fs.writeFileSync(tmpFile, jsonContent, "utf-8");
            fs.renameSync(tmpFile, DATA_FILE);
        } catch (renameErr) {
            // Direct write fallback on Windows if atomic rename is blocked by file lock or watcher
            fs.writeFileSync(DATA_FILE, jsonContent, "utf-8");
        }
        return true;
    } catch (error) {
        console.error("[StudyPilot Storage] Failed to save data file:", error.message);
        throw new Error(`Storage save error: ${error.message}`);
    }
}

/**
 * Get a specific study plan by planId
 * @param {string} planId
 * @returns {any | null}
 */
export function getPlan(planId = "default") {
    const plans = loadAllPlans();
    return plans[planId] || null;
}

/**
 * Save or update a specific study plan
 * @param {string} planId
 * @param {any} plan
 */
export function savePlan(planId = "default", plan) {
    const plans = loadAllPlans();
    plans[planId] = plan;
    saveAllPlans(plans);
    return plan;
}
