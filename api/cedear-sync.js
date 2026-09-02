import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import admin from 'firebase-admin';

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
    });
}

const db = admin.firestore();
const SOURCE_URL = 'https://www.comafi.com.ar/Programas-CEDEARs-2483.note.aspx';
const USER_AGENT = 'Mozilla/5.0 (compatible; TradesLogger/1.0)';
const SYNC_TTL_DAYS = 7;
const META_DOC_PATH = ['appMeta', 'cedearSync'];
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'garcialeonel1990@gmail.com';

function normalizeTicker(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value).trim().toUpperCase().replace(/\.C$/, 'C');
}

function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDecimal(value) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim().replace(/\$/g, '');
    const normalized = text.includes(',')
        ? text.replace(/\./g, '').replace(',', '.')
        : text;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
}

function parseRatio(text) {
    const cleaned = normalizeText(text).replace(/\s/g, '');
    if (!cleaned) return null;
    if (!cleaned.includes(':')) return parseDecimal(cleaned);

    const [leftText, rightText] = cleaned.split(':', 2);
    const left = parseDecimal(leftText);
    const right = parseDecimal(rightText);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return null;
    return Number((left / right).toFixed(6));
}

async function fetchComafiCedears() {
    const response = await fetch(SOURCE_URL, {
        headers: { 'User-Agent': USER_AGENT }
    });
    if (!response.ok) {
        throw new Error(`Comafi devolvio HTTP ${response.status}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const tables = Array.from(document.querySelectorAll('table'));
    const rows = [];

    for (const table of tables) {
        const headers = Array.from(table.querySelectorAll('th')).map((cell) => normalizeText(cell.textContent));
        const headerBlob = headers.join(' | ').toLowerCase();
        if (!headerBlob.includes('ticker en mercado de origen') || !headerBlob.includes('ratio')) {
            continue;
        }

        for (const tr of Array.from(table.querySelectorAll('tr'))) {
            const cells = Array.from(tr.querySelectorAll('td')).map((cell) => normalizeText(cell.textContent));
            if (cells.length < 7) continue;

            const ticker = normalizeTicker(cells[5]);
            const tickerUsa = normalizeTicker(cells[6]) || ticker;
            const ratio = parseRatio(cells[2]);

            if (!ticker || !tickerUsa || !Number.isFinite(ratio) || ratio <= 0) {
                continue;
            }

            rows.push({
                ticker,
                nombre: cells[0],
                tickerUsa,
                ratio,
                sourceUrl: SOURCE_URL,
                sourceCountry: cells[9] || '',
                sourceMarket: cells[10] || '',
            });
        }

        if (rows.length > 0) break;
    }

    if (rows.length === 0) {
        throw new Error('No pude parsear la tabla de CEDEARs de Comafi');
    }

    const unique = new Map();
    rows.forEach((row) => unique.set(row.ticker, row));
    return Array.from(unique.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function loadFirestoreTickers() {
    const snapshot = await db.collection('tickers').orderBy('ticker', 'asc').get();
    const rows = new Map();

    snapshot.forEach((doc) => {
        const data = doc.data() || {};
        const ticker = normalizeTicker(data.ticker);
        if (!ticker) return;

        rows.set(ticker, {
            id: doc.id,
            ref: doc.ref,
            ticker,
            nombre: data.nombre || '',
            tickerUsa: normalizeTicker(data.tickerUsa || data.underlyingTicker),
            ratio: typeof data.ratio === 'number' ? data.ratio : parseDecimal(data.ratio),
            ratioHistory: Array.isArray(data.ratioHistory) ? data.ratioHistory : [],
        });
    });

    return rows;
}

function buildRatioHistory(current, nextRow, effectiveDate) {
    const history = Array.isArray(current?.ratioHistory)
        ? current.ratioHistory.map((item) => ({ ...item }))
        : [];

    const currentTickerUsa = current?.tickerUsa || null;
    const currentRatio = current?.ratio || null;
    const unchanged = current && currentTickerUsa === nextRow.tickerUsa && currentRatio === nextRow.ratio;
    if (unchanged) {
        return history;
    }

    history.forEach((entry) => {
        if (entry && typeof entry === 'object' && !entry.validTo) {
            entry.validTo = effectiveDate;
        }
    });

    history.push({
        ratio: Number(nextRow.ratio.toFixed(6)),
        tickerUsa: nextRow.tickerUsa,
        validFrom: effectiveDate,
        validTo: null,
        source: 'comafi',
        sourceUrl: nextRow.sourceUrl,
    });

    return history;
}

function compareCedears(sourceRows, firestoreRows) {
    const results = [];

    sourceRows.forEach((row) => {
        const current = firestoreRows.get(row.ticker);
        if (!current) {
            results.push({
                ticker: row.ticker,
                action: 'create',
                reason: 'ticker faltante',
                current,
                next: row,
            });
            return;
        }

        const ratioChanged = current.ratio !== row.ratio;
        const tickerUsaChanged = current.tickerUsa !== row.tickerUsa;
        if (ratioChanged || tickerUsaChanged) {
            const reasons = [];
            if (ratioChanged) reasons.push('ratio');
            if (tickerUsaChanged) reasons.push('tickerUsa');
            results.push({
                ticker: row.ticker,
                action: 'update',
                reason: reasons.join(', '),
                current,
                next: row,
            });
            return;
        }

        results.push({
            ticker: row.ticker,
            action: 'ok',
            reason: 'sin cambios',
            current,
            next: row,
        });
    });

    return results;
}

async function applySync(results, effectiveDate) {
    const batch = db.batch();
    let applied = 0;
    let created = 0;
    let updated = 0;
    const ratioChangedTickers = [];
    const tickerUsaChangedTickers = [];

    results.forEach((item) => {
        if (item.action !== 'create' && item.action !== 'update') return;

        const current = item.current;
        const nextRow = item.next;
        const ratioHistory = buildRatioHistory(current, nextRow, effectiveDate);
        const now = admin.firestore.FieldValue.serverTimestamp();
        const payload = {
            ticker: nextRow.ticker,
            nombre: nextRow.nombre,
            tickerUsa: nextRow.tickerUsa,
            ratio: Number(nextRow.ratio.toFixed(6)),
            ratioHistory,
            source: 'comafi',
            sourceUrl: nextRow.sourceUrl,
            sourceCountry: nextRow.sourceCountry,
            sourceMarket: nextRow.sourceMarket,
            sourceUpdatedAt: now,
        };

        const ref = current?.ref || db.collection('tickers').doc(nextRow.ticker);
        batch.set(ref, payload, { merge: true });
        applied += 1;
        if (item.action === 'create') created += 1;
        if (item.action === 'update') updated += 1;
        if (item.reason.includes('ratio')) ratioChangedTickers.push(item.ticker);
        if (item.reason.includes('tickerUsa')) tickerUsaChangedTickers.push(item.ticker);
    });

    if (applied > 0) {
        await batch.commit();
    }

    return {
        applied,
        created,
        updated,
        ratioChangedTickers,
        tickerUsaChangedTickers,
    };
}

function isStale(lastAppliedAt) {
    if (!lastAppliedAt) return true;
    const lastDate = typeof lastAppliedAt.toDate === 'function'
        ? lastAppliedAt.toDate()
        : new Date(lastAppliedAt);
    if (Number.isNaN(lastDate.getTime())) return true;

    const ttlMs = SYNC_TTL_DAYS * 24 * 60 * 60 * 1000;
    return (Date.now() - lastDate.getTime()) >= ttlMs;
}

function getBearerToken(req) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
}

async function requireAdminUser(req, res) {
    const token = getBearerToken(req);
    if (!token) {
        res.status(401).json({ error: 'Missing Authorization bearer token' });
        return null;
    }

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        if (decoded.email !== ADMIN_EMAIL) {
            res.status(403).json({ error: 'Forbidden' });
            return null;
        }
        return decoded;
    } catch (error) {
        console.error('[CEDEAR Sync] Auth error:', error.message);
        res.status(401).json({ error: 'Invalid Authorization bearer token' });
        return null;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const adminUser = await requireAdminUser(req, res);
    if (!adminUser) return;

    const mode = String(req.query.mode || 'auto').toLowerCase();
    const force = req.query.force === '1' || req.query.force === 'true';
    const metaRef = db.collection(META_DOC_PATH[0]).doc(META_DOC_PATH[1]);

    try {
        const metaSnap = await metaRef.get();
        const meta = metaSnap.exists ? metaSnap.data() : {};
        const stale = force || isStale(meta.lastAppliedAt);

        if (mode === 'auto' && !stale) {
            await metaRef.set({
                lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastStatus: 'fresh-skip',
                ttlDays: SYNC_TTL_DAYS,
            }, { merge: true });

            return res.status(200).json({
                ok: true,
                mode,
                stale: false,
                applied: false,
                ttlDays: SYNC_TTL_DAYS,
                lastAppliedAt: meta.lastAppliedAt?.toDate?.()?.toISOString?.() || null,
                message: 'Master CEDEAR al dia; no hizo falta sincronizar.',
            });
        }

        const effectiveDate = new Date().toISOString().slice(0, 10);
        const sourceRows = await fetchComafiCedears();
        const firestoreRows = await loadFirestoreTickers();
        const results = compareCedears(sourceRows, firestoreRows);
        const summary = await applySync(results, effectiveDate);

        await metaRef.set({
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastAppliedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastStatus: 'ok',
            ttlDays: SYNC_TTL_DAYS,
            sourceUrl: SOURCE_URL,
            effectiveDate,
            totalOfficialCedears: sourceRows.length,
            changesDetected: summary.created + summary.updated,
            createdCount: summary.created,
            updatedCount: summary.updated,
            ratioChangedTickers: summary.ratioChangedTickers,
            tickerUsaChangedTickers: summary.tickerUsaChangedTickers,
            holdingsAdjustmentRecommended: summary.ratioChangedTickers.length > 0,
        }, { merge: true });

        return res.status(200).json({
            ok: true,
            mode,
            stale: true,
            applied: true,
            ttlDays: SYNC_TTL_DAYS,
            effectiveDate,
            totalOfficialCedears: sourceRows.length,
            createdCount: summary.created,
            updatedCount: summary.updated,
            appliedCount: summary.applied,
            ratioChangedTickers: summary.ratioChangedTickers,
            tickerUsaChangedTickers: summary.tickerUsaChangedTickers,
            holdingsAdjustmentRecommended: summary.ratioChangedTickers.length > 0,
        });
    } catch (error) {
        await metaRef.set({
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastStatus: 'error',
            lastError: error.message,
            ttlDays: SYNC_TTL_DAYS,
        }, { merge: true });

        console.error('[CEDEAR Sync] Error:', error);
        return res.status(500).json({
            ok: false,
            error: 'cedear-sync-failed',
            details: error.message,
        });
    }
}
