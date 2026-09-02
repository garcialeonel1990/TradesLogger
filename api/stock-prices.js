// Vercel Serverless Function para obtener precios actuales en lote desde Yahoo Finance

const MAX_TICKERS = 50;

function parseTickers(value) {
    return String(value || '')
        .split(',')
        .map((ticker) => ticker.trim().toUpperCase())
        .filter(Boolean)
        .filter((ticker, index, arr) => arr.indexOf(ticker) === index)
        .slice(0, MAX_TICKERS);
}

async function fetchCurrentPrice(ticker) {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const response = await fetch(yahooUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TradesLogger/1.0)',
        }
    });

    if (!response.ok) {
        throw new Error(`Yahoo Finance returned ${response.status}`);
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const price = result?.meta?.regularMarketPrice;

    if (!price) {
        throw new Error('Price not found');
    }

    return parseFloat(price.toFixed(2));
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const tickers = parseTickers(req.query.tickers);

    if (tickers.length === 0) {
        return res.status(400).json({ error: 'At least one ticker is required' });
    }

    try {
        const results = await Promise.allSettled(
            tickers.map(async (ticker) => [ticker, await fetchCurrentPrice(ticker)])
        );

        const prices = {};
        const errors = {};

        results.forEach((result, index) => {
            const ticker = tickers[index];
            if (result.status === 'fulfilled') {
                const [symbol, price] = result.value;
                prices[symbol] = { price, source: 'yahoo' };
            } else {
                errors[ticker] = result.reason?.message || 'Failed to fetch price';
            }
        });

        return res.status(200).json({
            prices,
            errors,
            requested: tickers.length,
            resolved: Object.keys(prices).length
        });
    } catch (error) {
        console.error('Error fetching stock prices:', error);
        return res.status(500).json({
            error: 'Failed to fetch stock prices',
            details: error.message
        });
    }
}
