// Gestión de cargas de criptos (Bull Run) en Firebase Firestore
// Estructura: bullrun/{cripto}/compras/{fecha_timestamp}
import {
    collection,
    doc,
    setDoc,
    getDocs,
    query,
    where,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const CRYPTO_PRICE_CACHE_MS = 60 * 1000;
let cryptoPriceCache = {
    expiresAt: 0,
    data: null
};

/**
 * Guardar una nueva carga de cripto en Firestore.
 * @param {Object} data - { cripto, fecha, precio, cantidad }
 * @returns {Promise<boolean>} - true si se guardó correctamente
 */
export async function saveBullrun(data) {
    const user = window.firebaseAuth.currentUser;
    if (!user) {
        throw new Error('Usuario no autenticado');
    }

    const db = window.firebaseDb;
    const timestamp = Date.now(); // timestamp del momento de presionar "Cargar"
    const cripto = data.cripto.toUpperCase();
    const docId = `${data.fecha}_${timestamp}`;

    // Asegurar que el documento padre de la cripto exista (para que sea visible en la consola)
    await setDoc(
        doc(db, 'bullrun', cripto),
        { cripto, updatedAt: serverTimestamp() },
        { merge: true }
    );

    // Guardar la carga dentro de la subcolección "compras"
    const entryRef = doc(db, 'bullrun', cripto, 'compras', docId);
    await setDoc(entryRef, {
        cripto,
        fecha: data.fecha,
        precio: data.precio,
        cantidad: data.cantidad,
        timestamp: serverTimestamp(),
        userId: user.uid,
        username: user.displayName || user.email,
        createdAt: serverTimestamp()
    });

    return true;
}

/**
 * Guardar una venta de cripto en Firestore.
 * Calcula y CONGELA la ganancia usando el precio promedio ponderado de compra
 * al momento de la venta (método de costo promedio).
 * @param {Object} data - { cripto, fecha, precio, cantidad }
 * @returns {Promise<Object>} - { ganancia, gananciaPct, costoBase }
 */
export async function saveVenta(data) {
    const user = window.firebaseAuth.currentUser;
    if (!user) {
        throw new Error('Usuario no autenticado');
    }

    const db = window.firebaseDb;
    const cripto = data.cripto.toUpperCase();

    // Resumen actual para validar tenencia y obtener el costo promedio
    const resumen = await getResumenCripto(cripto);

    if (data.cantidad > resumen.tenencia + 1e-12) {
        throw new Error(
            `Solo tenés ${resumen.tenencia} ${cripto} disponibles para vender`
        );
    }

    const costoBase = resumen.precioPromedio;
    const ganancia = data.cantidad * (data.precio - costoBase);
    const gananciaPct = costoBase > 0 ? (data.precio / costoBase - 1) * 100 : 0;

    const timestamp = Date.now();
    const docId = `${data.fecha}_${timestamp}`;

    await setDoc(
        doc(db, 'bullrun', cripto),
        { cripto, updatedAt: serverTimestamp() },
        { merge: true }
    );

    const entryRef = doc(db, 'bullrun', cripto, 'ventas', docId);
    await setDoc(entryRef, {
        cripto,
        fecha: data.fecha,
        precio: data.precio,
        cantidad: data.cantidad,
        costoBase: parseFloat(costoBase.toFixed(8)),
        ganancia: parseFloat(ganancia.toFixed(2)),
        gananciaPct: parseFloat(gananciaPct.toFixed(2)),
        timestamp: serverTimestamp(),
        userId: user.uid,
        username: user.displayName || user.email,
        createdAt: serverTimestamp()
    });

    return { ganancia, gananciaPct, costoBase };
}

/**
 * Obtener todas las cargas de una cripto, ordenadas por timestamp ascendente.
 * Útil para calcular precio promedio ponderado y cantidad total.
 * @param {string} cripto - BTC | HYPE | SOL
 * @returns {Promise<Array>}
 */
export async function getBullrunByCripto(cripto) {
    const user = window.firebaseAuth.currentUser;
    if (!user) {
        throw new Error('Usuario no autenticado');
    }

    const db = window.firebaseDb;
    const criptoUpper = cripto.toUpperCase();

    const comprasRef = collection(db, 'bullrun', criptoUpper, 'compras');
    const q = query(comprasRef, where('userId', '==', user.uid));
    const snapshot = await getDocs(q);

    const compras = [];
    snapshot.forEach((d) => {
        const data = d.data();
        compras.push({
            id: d.id,
            cripto: data.cripto,
            fecha: data.fecha,
            precio: data.precio,
            cantidad: data.cantidad,
            timestamp: data.timestamp?.toDate?.() || (data.createdAt?.toDate?.() || new Date())
        });
    });

    compras.sort((a, b) => a.timestamp - b.timestamp);
    return compras;
}

/**
 * Obtener todas las ventas de una cripto, ordenadas por timestamp ascendente.
 * @param {string} cripto - BTC | HYPE | SOL
 * @returns {Promise<Array>}
 */
export async function getVentasByCripto(cripto) {
    const user = window.firebaseAuth.currentUser;
    if (!user) {
        throw new Error('Usuario no autenticado');
    }

    const db = window.firebaseDb;
    const criptoUpper = cripto.toUpperCase();

    const ventasRef = collection(db, 'bullrun', criptoUpper, 'ventas');
    const q = query(ventasRef, where('userId', '==', user.uid));
    const snapshot = await getDocs(q);

    const ventas = [];
    snapshot.forEach((d) => {
        const data = d.data();
        ventas.push({
            id: d.id,
            cripto: data.cripto,
            fecha: data.fecha,
            precio: data.precio,
            cantidad: data.cantidad,
            costoBase: data.costoBase,
            ganancia: data.ganancia,
            gananciaPct: data.gananciaPct,
            timestamp: data.timestamp?.toDate?.() || (data.createdAt?.toDate?.() || new Date())
        });
    });

    ventas.sort((a, b) => a.timestamp - b.timestamp);
    return ventas;
}

// Mapeo de símbolos a IDs de CoinGecko
export const CRIPTOS = ['BTC', 'HYPE', 'SOL'];
const COINGECKO_IDS = { BTC: 'bitcoin', HYPE: 'hyperliquid', SOL: 'solana' };

/**
 * Obtener los precios actuales (USD) de las criptos desde CoinGecko.
 * @returns {Promise<Object>} - { BTC: 61418, HYPE: 60.29, SOL: 64.43 }
 */
export async function getPreciosActuales(options = {}) {
    const force = options.force === true;
    if (!force && cryptoPriceCache.data && Date.now() < cryptoPriceCache.expiresAt) {
        return cryptoPriceCache.data;
    }

    const ids = Object.values(COINGECKO_IDS).join(',');
    const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );
    if (!res.ok) {
        throw new Error('No se pudo obtener precios de CoinGecko');
    }
    const data = await res.json();
    const precios = {};
    for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
        precios[sym] = data[id]?.usd ?? null;
    }

    cryptoPriceCache = {
        data: precios,
        expiresAt: Date.now() + CRYPTO_PRICE_CACHE_MS
    };

    return precios;
}

function buildResumenCripto(compras, ventas) {
    let cantidadComprada = 0;
    let invertido = 0;
    compras.forEach((c) => {
        cantidadComprada += c.cantidad;
        invertido += c.precio * c.cantidad;
    });

    const precioPromedio = cantidadComprada > 0 ? invertido / cantidadComprada : 0;

    let cantidadVendida = 0;
    let gananciaRealizada = 0;
    ventas.forEach((v) => {
        cantidadVendida += v.cantidad;
        gananciaRealizada += v.ganancia || 0;
    });

    const tenencia = cantidadComprada - cantidadVendida;

    return {
        cantidadComprada,
        cantidadVendida,
        tenencia,
        invertido,
        precioPromedio,
        gananciaRealizada,
        cargas: compras.length,
        ventas: ventas.length
    };
}

export async function getCryptoPortfolioData() {
    const [comprasPorCripto, ventasPorCripto] = await Promise.all([
        Promise.all(CRIPTOS.map((c) => getBullrunByCripto(c))),
        Promise.all(CRIPTOS.map((c) => getVentasByCripto(c)))
    ]);

    const resumenes = comprasPorCripto.map((compras, index) => (
        buildResumenCripto(compras, ventasPorCripto[index])
    ));

    return {
        comprasPorCripto,
        ventasPorCripto,
        resumenes
    };
}

/**
 * Calcular el resumen de una cripto: promedio ponderado de compra, tenencia
 * actual (compras − ventas) y ganancia realizada (suma de ventas).
 * @param {string} cripto - BTC | HYPE | SOL
 * @returns {Promise<Object>}
 */
export async function getResumenCripto(cripto) {
    const [compras, ventas] = await Promise.all([
        getBullrunByCripto(cripto),
        getVentasByCripto(cripto)
    ]);
    return buildResumenCripto(compras, ventas);
}
