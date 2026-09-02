// Gestión de trades en Firebase Firestore
// Los imports de Firebase usan window global ya que firebase-init.js inicializa ahí
import { 
    collectionGroup,
    getDocs, 
    getDoc,
    query, 
    where, 
    deleteDoc, 
    updateDoc,
    doc,
    setDoc,
    serverTimestamp,
    Timestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

/**
 * Guardar un nuevo trade en Firestore con estructura organizada por fecha
 * @param {Object} tradeData - Datos del trade
 * @returns {Promise<boolean>} - true si se guardó correctamente
 */
export async function saveTrade(tradeData) {
    try {
        const user = window.firebaseAuth.currentUser;
        if (!user) {
            throw new Error('Usuario no autenticado');
        }

        const db = window.firebaseDb;
        const now = new Date();
        
        // Estructura: trades/{fecha}/items/{ticker-timestamp}
        const fecha = tradeData.fecha; // YYYY-MM-DD
        const timestamp = now.getTime();
        const docId = `${tradeData.ticker}-${timestamp}`;
        
        const tradeDocRef = doc(db, 'trades', fecha, 'items', docId);
        
        const tradeDoc = {
            fecha: tradeData.fecha,
            hora: tradeData.hora || '',
            ticker: tradeData.ticker.toUpperCase(), // Normalizar a mayúsculas
            tipo: tradeData.tipo,
            cantidad: tradeData.cantidad,
            priceCedear: tradeData.priceCedear,
            total: tradeData.total,
            timestamp: tradeData.timestamp ? Timestamp.fromDate(new Date(tradeData.timestamp)) : serverTimestamp(),
            userId: user.uid,
            username: user.displayName || user.email,
            createdAt: serverTimestamp()
        };

        [
            'source',
            'precioIolArs',
            'precioAccionUsd',
            'ratio',
            'tickerUsa',
            'precioUsdSourceDate',
            'precioUsdSourceTime',
            'precioUsdSource',
            'importKey'
        ].forEach((field) => {
            if (tradeData[field] !== undefined && tradeData[field] !== null && tradeData[field] !== '') {
                tradeDoc[field] = tradeData[field];
            }
        });

        await setDoc(tradeDocRef, tradeDoc);
        return true;
    } catch (error) {
        console.error('[ERROR] Error al guardar trade en Firestore:', error);
        console.error('[ERROR] Código de error:', error.code);
        console.error('[ERROR] Mensaje:', error.message);
        throw error;
    }
}

/**
 * Obtener todos los trades del usuario actual desde la estructura organizada
 * @returns {Promise<Array>} - Array de trades
 */
export async function getUserTrades() {
    try {
        const user = window.firebaseAuth.currentUser;
        if (!user) {
            throw new Error('Usuario no autenticado');
        }

        const db = window.firebaseDb;
        const itemsSnapshot = await getDocs(
            query(collectionGroup(db, 'items'), where('userId', '==', user.uid))
        );

        const allTrades = [];
        itemsSnapshot.forEach((doc) => {
            const data = doc.data();
            const pathParts = doc.ref.path.split('/');
            const fecha = pathParts[1]; // trades/{fecha}/items/{docId}

            allTrades.push({
                id: doc.id,
                fecha: data.fecha,
                hora: data.hora || '',
                ticker: data.ticker,
                tipo: data.tipo,
                cantidad: data.cantidad,
                priceCedear: data.priceCedear,
                precio: data.priceCedear,
                total: data.total,
                timestamp: data.timestamp?.toDate?.() || (data.createdAt?.toDate?.() || new Date()),
                username: data.username,
                source: data.source,
                precioIolArs: data.precioIolArs,
                precioAccionUsd: data.precioAccionUsd,
                ratio: data.ratio,
                tickerUsa: data.tickerUsa,
                precioUsdSourceDate: data.precioUsdSourceDate,
                precioUsdSourceTime: data.precioUsdSourceTime,
                precioUsdSource: data.precioUsdSource,
                importKey: data.importKey,
                _fechaPath: fecha
            });
        });

        allTrades.sort((a, b) => a.timestamp - b.timestamp);
        return allTrades;
    } catch (error) {
        console.error('[ERROR] Error al cargar trades desde Firestore:', error);
        throw error;
    }
}

/**
 * Obtener trades de un ticker específico del usuario actual
 * @param {string} ticker - Símbolo del ticker
 * @returns {Promise<Array>} - Array de trades del ticker
 */
export async function getTradesByTicker(ticker) {
    try {
        const user = window.firebaseAuth.currentUser;
        if (!user) {
            throw new Error('Usuario no autenticado');
        }

        const db = window.firebaseDb;
        const tickerUpper = ticker.toUpperCase();
        const itemsQuery = query(
            collectionGroup(db, 'items'),
            where('userId', '==', user.uid),
            where('ticker', '==', tickerUpper)
        );
        
        const itemsSnapshot = await getDocs(itemsQuery);
        const allTrades = [];
        itemsSnapshot.forEach((doc) => {
            const data = doc.data();
            const pathParts = doc.ref.path.split('/');
            const fechaPath = pathParts[1]; // trades/{fecha}/items/{docId}

            allTrades.push({
                id: doc.id,
                tipo: data.tipo,
                cantidad: data.cantidad,
                precio: data.priceCedear,
                priceCedear: data.priceCedear,
                fecha: data.fecha,
                hora: data.hora || '',
                timestamp: data.timestamp?.toDate?.() || (data.createdAt?.toDate?.() || new Date()),
                _fechaPath: fechaPath
            });
        });
        
        allTrades.sort((a, b) => a.timestamp - b.timestamp);
        return allTrades;
    } catch (error) {
        console.error(`[ERROR] Error al cargar trades del ticker ${ticker}:`, error);
        throw error;
    }
}

/**
 * Eliminar un trade
 * @param {string} tradeId - ID del trade  
 * @param {Object} tradeData - Datos del trade (debe incluir _fechaPath)
 * @returns {Promise<boolean>}
 */
export async function deleteTrade(tradeId, tradeData = null) {
    try {
        const user = window.firebaseAuth.currentUser;
        if (!user) {
            throw new Error('Usuario no autenticado');
        }

        if (!tradeData?._fechaPath) {
            throw new Error('No se pudo resolver la fecha del trade');
        }

        const db = window.firebaseDb;
        const tradeRef = doc(db, 'trades', tradeData._fechaPath, 'items', tradeId);
        
        const tradeDoc = await getDoc(tradeRef);

        if (!tradeDoc.exists()) {
            throw new Error('Trade no encontrado');
        }

        // Verificar que el trade pertenezca al usuario
        if (tradeDoc.data().userId !== user.uid) {
            throw new Error('No tienes permiso para eliminar este trade');
        }

        await deleteDoc(tradeRef);
        return true;
    } catch (error) {
        console.error('Error al eliminar trade:', error);
        throw error;
    }
}

/**
 * Actualizar un trade existente
 * @param {string} tradeId - ID del trade
 * @param {Object} updates - Campos a actualizar
 * @param {Object} tradeData - Datos del trade (debe incluir _fechaPath)
 * @returns {Promise<boolean>}
 */
export async function updateTrade(tradeId, updates, tradeData = null) {
    try {
        const user = window.firebaseAuth.currentUser;
        if (!user) {
            throw new Error('Usuario no autenticado');
        }

        if (!tradeData?._fechaPath) {
            throw new Error('No se pudo resolver la fecha del trade');
        }

        const db = window.firebaseDb;
        const tradeRef = doc(db, 'trades', tradeData._fechaPath, 'items', tradeId);
        
        const tradeDoc = await getDoc(tradeRef);

        if (!tradeDoc.exists()) {
            throw new Error('Trade no encontrado');
        }

        // Verificar que el trade pertenezca al usuario
        if (tradeDoc.data().userId !== user.uid) {
            throw new Error('No tienes permiso para editar este trade');
        }

        await updateDoc(tradeRef, {
            ...updates,
            updatedAt: Timestamp.now()
        });
        return true;
    } catch (error) {
        console.error('Error al actualizar trade:', error);
        throw error;
    }
}
