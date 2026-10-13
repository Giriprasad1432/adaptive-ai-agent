import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePlan } from "./planner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default data directory inside studypilot-server/data
const DATA_DIR = process.env.STUDYPILOT_DATA_DIR 
    ? path.resolve(process.cwd(), process.env.STUDYPILOT_DATA_DIR)
    : path.resolve(__dirname, "data");

export const DATA_FILE = path.join(DATA_DIR, "studypilot_data.json");

export const LOCK_FILE = `${DATA_FILE}.lock`;

/**
 * Ensures the data storage directory exists
 */
/**
 * Ensures the data storage directory exists
 */
function ensureDataDir(dir = DATA_DIR) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Synchronously acquires an exclusive lock on the storage data file.
 * Writes a unique ownership token into the lock file.
 * Retries up to maxWaitMs (5000ms) with small backoff.
 * Automatically clears stale lock files older than staleTimeoutMs (10000ms).
 * @returns {{ fd: number, token: string, lockFile: string } | null} Lock descriptor with token, or null on timeout
 */
export function acquireLock(maxWaitMs = 5000, retryIntervalMs = 25, staleTimeoutMs = 10000, lockFile = LOCK_FILE) {
    ensureDataDir(path.dirname(lockFile));
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const fd = fs.openSync(lockFile, "wx");
            const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            try {
                fs.writeSync(fd, token, 0, "utf-8");
            } catch {}
            return { fd, token, lockFile };
        } catch (err) {
            if (err.code === "EEXIST") {
                try {
                    const stats = fs.statSync(lockFile);
                    if (Date.now() - stats.mtimeMs > staleTimeoutMs) {
                        try { fs.unlinkSync(lockFile); } catch {}
                    }
                } catch {}

                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryIntervalMs);
                continue;
            }
            ensureDataDir(path.dirname(lockFile));
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryIntervalMs);
        }
    }
    console.warn(`[StudyPilot Storage] Lock acquisition timed out after ${maxWaitMs}ms.`);
    return null;
}

/**
 * Releases the exclusive storage lock.
 * Only closes fd and deletes target lock file if this invocation actually acquired the lock
 * and owns the current token.
 * @param {{ fd: number, token: string, lockFile?: string } | null} lock
 * @param {string} [lockFile]
 */
export function releaseLock(lock, lockFile = null) {
    if (!lock || typeof lock !== "object" || lock.fd === null || lock.fd === undefined) {
        return;
    }

    const targetLockFile = lock.lockFile || lockFile || LOCK_FILE;

    try {
        fs.closeSync(lock.fd);
    } catch {}

    try {
        if (fs.existsSync(targetLockFile)) {
            const currentToken = fs.readFileSync(targetLockFile, "utf-8").trim();
            if (currentToken === lock.token) {
                fs.unlinkSync(targetLockFile);
            }
        }
    } catch {}
}

/**
 * Executes a function within the exclusive storage lock.
 * If acquireLock returns null, throws a clear timeout error and does NOT execute fn.
 */
export function withFileLock(fn, maxWaitMs = 5000, retryIntervalMs = 25, lockFile = LOCK_FILE) {
    const lock = acquireLock(maxWaitMs, retryIntervalMs, 10000, lockFile);
    if (!lock) {
        throw new Error(`Storage lock acquisition timed out after ${maxWaitMs}ms.`);
    }
    try {
        return fn();
    } finally {
        releaseLock(lock, lockFile);
    }
}

/**
 * Loads the storage database from disk with retry resilience for concurrent access.
 * Returns {} if the data file does not exist (new installation).
 * If the file exists but cannot be read or parsed after retries, throws an error
 * to prevent destructive overwrites by subsequent saves.
 * @param {number} [retries=10]
 * @param {number} [retryDelayMs=25]
 * @param {string} [targetFile=DATA_FILE]
 * @returns {Record<string, any>} All stored plans keyed by planId
 */
export function loadAllPlans(retries = 10, retryDelayMs = 25, targetFile = DATA_FILE) {
    ensureDataDir(path.dirname(targetFile));
    if (!fs.existsSync(targetFile)) {
        return {};
    }

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const raw = fs.readFileSync(targetFile, "utf-8");
            if (!raw.trim()) {
                // If file is temporarily empty (e.g. during concurrent atomic write/flush), retry
                if (attempt < retries - 1) {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
                    continue;
                }
                throw new Error(`Storage data file is empty: "${targetFile}".`);
            }
            return JSON.parse(raw);
        } catch (error) {
            lastError = error;
            // If file was locked or mid-write (EBUSY, EPERM, SyntaxError), retry
            if (attempt < retries - 1) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
                continue;
            }
        }
    }
    console.error("[StudyPilot Storage] Failed to load data file after retries:", lastError?.message);
    throw new Error(`Failed to read storage data file "${targetFile}" after ${retries} attempts: ${lastError?.message}`);
}

/**
 * Internal atomic disk write without acquiring lock (caller must hold lock if needed).
 * Writes to a unique temp file first, then atomically renames to targetFile.
 * Eliminates non-atomic truncation fallbacks to guarantee existing data is never corrupted.
 */
function _saveAllPlansUnlocked(data, targetFile = DATA_FILE) {
    ensureDataDir(path.dirname(targetFile));
    const jsonContent = JSON.stringify(data, null, 2);
    const tmpFile = `${targetFile}.${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpFile, jsonContent, "utf-8");
        let renamed = false;
        let lastRenameError = null;
        const maxRenameAttempts = 10;
        const renameRetryDelayMs = 25;

        for (let i = 0; i < maxRenameAttempts; i++) {
            try {
                fs.renameSync(tmpFile, targetFile);
                renamed = true;
                break;
            } catch (rErr) {
                lastRenameError = rErr;
                if (i < maxRenameAttempts - 1 && (rErr.code === "EPERM" || rErr.code === "EBUSY" || rErr.code === "EEXIST" || rErr.code === "EACCES")) {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, renameRetryDelayMs);
                    continue;
                }
                break;
            }
        }

        if (!renamed) {
            throw new Error(`Atomic replacement failed after ${maxRenameAttempts} attempts: ${lastRenameError?.message}`);
        }
        return true;
    } catch (error) {
        console.error("[StudyPilot Storage] Failed to save data file:", error.message);
        throw new Error(`Storage save error: ${error.message}`);
    } finally {
        if (fs.existsSync(tmpFile)) {
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    }
}

/**
 * Saves all plans to disk safely within an exclusive lock.
 * @param {Record<string, any>} data
 * @param {string} [targetFile=DATA_FILE]
 */
export function saveAllPlans(data, targetFile = DATA_FILE) {
    const lockFile = `${targetFile}.lock`;
    return withFileLock(() => {
        return _saveAllPlansUnlocked(data, targetFile);
    }, 5000, 25, lockFile);
}

/**
 * Get a specific study plan by planId
 * @param {string} planId
 * @param {string} [targetFile=DATA_FILE]
 * @returns {any | null}
 */
export function getPlan(planId = "default", targetFile = DATA_FILE) {
    let plans = loadAllPlans(10, 25, targetFile);
    let plan = plans[planId] || null;
    if (!plan && fs.existsSync(targetFile)) {
        // Brief retry on Windows in case of concurrent flush
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        plans = loadAllPlans(10, 25, targetFile);
        plan = plans[planId] || null;
    }
    if (plan) {
        normalizePlan(plan);
    }
    return plan;
}

/**
 * Save or update a specific study plan atomically within an exclusive lock,
 * guaranteeing no concurrent read-modify-write lost updates.
 * @param {string} planId
 * @param {any} plan
 * @param {string} [targetFile=DATA_FILE]
 */
export function savePlan(planId = "default", plan, targetFile = DATA_FILE) {
    const lockFile = `${targetFile}.lock`;
    return withFileLock(() => {
        const plans = loadAllPlans(10, 25, targetFile);
        plans[planId] = plan;
        _saveAllPlansUnlocked(plans, targetFile);
        return plan;
    }, 5000, 25, lockFile);
}

/** Create-only save: fail instead of replacing an existing plan with the same ID. */
export function saveNewPlan(planId, plan, targetFile = DATA_FILE) {
    const lockFile = `${targetFile}.lock`;
    return withFileLock(() => {
        const plans = loadAllPlans(10, 25, targetFile);
        if (Object.hasOwn(plans, planId)) return false;
        plans[planId] = plan;
        _saveAllPlansUnlocked(plans, targetFile);
        return true;
    }, 5000, 25, lockFile);
}

/**
 * Transactionally updates an existing study plan under an exclusive lock.
 * Holds the cross-process file lock across reading the latest database from disk,
 * mutating the selected plan via mutatorFn(plan), and atomically persisting the result.
 * If the plan does not exist, returns null without writing to disk.
 * If mutatorFn throws an error, no changes are persisted to disk and the lock is cleanly released.
 *
 * @param {string} planId
 * @param {(plan: any) => any} mutatorFn Callback receiving the fresh, normalized plan
 * @param {string} [targetFile=DATA_FILE]
 * @returns {{ plan: any, result: any } | null} The persisted plan and mutator result, or null if plan not found
 */
export function updatePlan(planId = "default", mutatorFn, targetFile = DATA_FILE) {
    const lockFile = `${targetFile}.lock`;
    return withFileLock(() => {
        const plans = loadAllPlans(10, 25, targetFile);
        const plan = plans[planId];
        if (!plan) {
            return null;
        }

        normalizePlan(plan);
        const isolatedPlan = structuredClone(plan);
        const mutatorResult = mutatorFn(isolatedPlan);

        // Use returned plan if mutatorFn returned a replacement plan object; otherwise use mutated clone
        plans[planId] = (mutatorResult && typeof mutatorResult === "object" && mutatorResult.planId === planId)
            ? mutatorResult
            : isolatedPlan;

        _saveAllPlansUnlocked(plans, targetFile);
        return { plan: plans[planId], result: mutatorResult };
    }, 5000, 25, lockFile);
}
