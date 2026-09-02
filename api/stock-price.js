// Vercel Serverless Function para obtener precios de Yahoo Finance
// Soporta precios actuales e históricos (intraday)

export default async function handler(req, res) {
    // Habilitar CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Manejar preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Solo GET
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { ticker, date, time } = req.query;

    if (!ticker) {
        return res.status(400).json({ error: 'Ticker is required' });
    }

    try {
        let yahooUrl;
        let interval = '1d';
        
        // Si se proporciona fecha y hora, buscar precio histórico intraday
        if (date && time) {
            // Convertir fecha y hora Argentina (UTC-3) a timestamp Unix
            const targetDateTime = new Date(`${date}T${time}:00-03:00`); // Argentina es UTC-3
            const period1 = Math.floor(targetDateTime.getTime() / 1000) - 3600; // 1 hora antes
            const period2 = Math.floor(targetDateTime.getTime() / 1000) + 3600; // 1 hora después
            
            // Usar intervalo de 5 minutos para datos intraday
            interval = '5m';
            yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=${interval}`;
        } else if (date) {
            // Solo fecha, obtener precio de cierre del día
            const targetDate = new Date(date);
            const period1 = Math.floor(targetDate.getTime() / 1000);
            const period2 = Math.floor(new Date(targetDate.getTime() + 86400000).getTime() / 1000); // +1 día
            
            yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`;
        } else {
            // Precio actual del día
            yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        }
        
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
        
        if (!result) {
            return res.status(404).json({ error: 'No data found' });
        }

        let price;
        
        if (date && time) {
            // Buscar el precio más cercano a la hora solicitada
            const timestamps = result.timestamp;
            const quotes = result.indicators?.quote?.[0];
            
            if (!timestamps || !quotes || timestamps.length === 0) {
                return res.status(404).json({ error: 'No intraday data available' });
            }
            
            const targetTime = new Date(`${date}T${time}:00-03:00`).getTime() / 1000; // Argentina UTC-3
            
            // Encontrar el timestamp más cercano
            let closestIndex = 0;
            let minDiff = Math.abs(timestamps[0] - targetTime);
            
            for (let i = 1; i < timestamps.length; i++) {
                const diff = Math.abs(timestamps[i] - targetTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestIndex = i;
                }
            }
            
            // Usar el precio de cierre del intervalo más cercano
            price = quotes.close[closestIndex];
            
        } else if (date) {
            // Precio de cierre del día
            const quotes = result.indicators?.quote?.[0];
            price = quotes?.close?.[0];
        } else {
            // Precio actual del mercado
            price = result.meta?.regularMarketPrice;
        }

        if (!price) {
            return res.status(404).json({ error: 'Price not found' });
        }

        return res.status(200).json({ 
            ticker,
            price: parseFloat(Number(price).toFixed(6)),
            date: date || 'current',
            time: time || 'market',
            source: 'yahoo'
        });

    } catch (error) {
        console.error('Error fetching stock price:', error);
        return res.status(500).json({ 
            error: 'Failed to fetch stock price',
            details: error.message 
        });
    }
}
