// Gestión de Tickers en Firebase Firestore
import { 
    collection, 
    getDocs, 
    addDoc, 
    deleteDoc, 
    doc, 
    query, 
    orderBy,
    updateDoc 
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const TICKERS_COLLECTION = 'tickers';
const TICKER_CATEGORY_ORDER = ['argentina', 'etf', 'usa', 'adr', 'otros'];
const TICKER_CATEGORY_LABELS = {
    argentina: 'ARG',
    etf: 'ETF / Trust',
    usa: 'USA',
    adr: 'ADR',
    otros: 'Otros'
};

const ARGENTINA_TICKER_SET = new Set([
    'BBAR',
    'BMA',
    'CEPU',
    'COME',
    'CRES',
    'EDN',
    'GGAL',
    'LOMA',
    'METR',
    'PAMP',
    'SUPV',
    'TECO2',
    'TGNO4',
    'TGSU2',
    'TXAR',
    'VALO',
    'YPFD'
]);

// Variable global para almacenar tickers
export let tickersData = [];

function setTickersModalState(modal, isOpen) {
    if (!modal) return;
    modal.style.display = isOpen ? 'flex' : 'none';
    document.body.classList.toggle('modal-open', isOpen);
}

function normalizeText(value) {
    return String(value || '').trim();
}

function getShortTickerName(name) {
    const normalized = normalizeText(name);
    if (!normalized) return '-';

    const compact = normalized
        .replace(/\bS\.?A\.?\b/gi, '')
        .replace(/\bADR\b/gi, '')
        .replace(/\bHOLDINGS?\b/gi, '')
        .replace(/\bCORPORATION\b/gi, 'Corp')
        .replace(/\bCOMPANY\b/gi, 'Co')
        .replace(/\bBANCO\b/gi, 'Bco')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return compact.length > 22 ? `${compact.slice(0, 22).trim()}...` : compact;
}

function inferTickerCategory(ticker) {
    const explicitType = normalizeText(
        ticker.instrumentType || ticker.type || ticker.category
    ).toLowerCase();
    if (explicitType) {
        if (['argentina', 'local', 'byma'].includes(explicitType)) return 'argentina';
        if (explicitType === 'etf') return 'etf';
        if (['usa', 'equity', 'stock'].includes(explicitType)) return 'usa';
        if (['etn', 'trust', 'etc'].includes(explicitType)) return 'etf';
        if (explicitType === 'adr') return 'adr';
    }

    const symbol = String(ticker.ticker || '').toUpperCase();
    const name = normalizeText(ticker.nombre).toLowerCase();

    if (ARGENTINA_TICKER_SET.has(symbol)) return 'argentina';
    if (name.includes(' adr') || name.includes('- adr') || name.includes(' adr ')) return 'adr';
    if (name.includes(' etn') || name.includes(' trust') || name.includes('futures etn')) return 'etf';
    if (name.includes(' etf') || name.includes(' fund') || name.includes(' index fund')) return 'etf';
    if (!Number.isFinite(Number(ticker.ratio)) || Number(ticker.ratio) <= 0) return 'argentina';
    if (/\d/.test(symbol) && !name.includes('etf')) return 'adr';
    return 'usa';
}

function renderTickerTypeBadge(category) {
    const label = TICKER_CATEGORY_LABELS[category] || TICKER_CATEGORY_LABELS.otros;
    return `<span class="ticker-type-badge ticker-type-${category}">${label}</span>`;
}

/**
 * Cargar tickers desde Firestore con cache
 */
export async function loadTickersFromFirestore() {
    try {
        // Verificar cache primero
        const cached = localStorage.getItem('tickers_cache');
        const cacheTime = localStorage.getItem('tickers_cache_time');
        
        if (cached && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            if (age < 5 * 60 * 1000) { // 5 minutos
                tickersData = JSON.parse(cached);
                console.log(`✅ Cargados ${tickersData.length} tickers desde cache`);
                return tickersData;
            }
        }
        
        // Si no hay cache válido, consultar Firestore
        const db = window.firebaseDb;
        const tickersRef = collection(db, TICKERS_COLLECTION);
        const q = query(tickersRef, orderBy('ticker', 'asc'));
        
        const querySnapshot = await getDocs(q);
        
        tickersData = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            tickersData.push({
                id: doc.id,
                ...data,
                ticker: data.ticker.toUpperCase(), // Normalizar a mayúsculas al cargar
                tickerUsa: data.tickerUsa ? data.tickerUsa.toUpperCase() : ''
            });
        });
        
        // Guardar en cache
        localStorage.setItem('tickers_cache', JSON.stringify(tickersData));
        localStorage.setItem('tickers_cache_time', Date.now().toString());
        
        console.log(`✅ Cargados ${tickersData.length} tickers desde Firestore`);
        return tickersData;
        
    } catch (error) {
        console.error('Error al cargar tickers desde Firestore:', error);
        return [];
    }
}

/**
 * Agregar un nuevo ticker a Firestore
 */
export async function addTicker(ticker, nombre, ratio, tickerUsa) {
    try {
        const db = window.firebaseDb;
        const tickersRef = collection(db, TICKERS_COLLECTION);
        
        // Validar que no exista
        const exists = tickersData.find(t => t.ticker.toUpperCase() === ticker.toUpperCase());
        if (exists) {
            throw new Error('El ticker ya existe');
        }
        
        const newTicker = {
            ticker: ticker.toUpperCase(),
            nombre: nombre,
            tickerUsa: tickerUsa.toUpperCase(),
            ratio: parseFloat(ratio),
            createdAt: new Date().toISOString()
        };
        
        const docRef = await addDoc(tickersRef, newTicker);
        
        // Actualizar array local
        tickersData.push({
            id: docRef.id,
            ...newTicker
        });
        
        // Ordenar
        tickersData.sort((a, b) => a.ticker.localeCompare(b.ticker));
        
        // Invalidar cache
        localStorage.removeItem('tickers_cache');
        localStorage.removeItem('tickers_cache_time');
        
        console.log(`✅ Ticker ${ticker} agregado correctamente`);
        return { id: docRef.id, ...newTicker };
        
    } catch (error) {
        console.error('Error al agregar ticker:', error);
        throw error;
    }
}

/**
 * Eliminar un ticker de Firestore
 */
export async function deleteTicker(tickerId) {
    try {
        const db = window.firebaseDb;
        const tickerRef = doc(db, TICKERS_COLLECTION, tickerId);
        
        await deleteDoc(tickerRef);
        
        // Actualizar array local
        tickersData = tickersData.filter(t => t.id !== tickerId);
        
        // Invalidar cache
        localStorage.removeItem('tickers_cache');
        localStorage.removeItem('tickers_cache_time');
        
        console.log(`✅ Ticker eliminado correctamente`);
        
    } catch (error) {
        console.error('Error al eliminar ticker:', error);
        throw error;
    }
}

/**
 * Actualizar ticker existente
 */
export async function updateTicker(tickerId, updates) {
    try {
        const db = window.firebaseDb;
        const tickerRef = doc(db, TICKERS_COLLECTION, tickerId);
        
        await updateDoc(tickerRef, {
            ...updates,
            tickerUsa: updates.tickerUsa ? updates.tickerUsa.toUpperCase() : updates.tickerUsa,
            updatedAt: new Date().toISOString()
        });
        
        // Actualizar array local
        const index = tickersData.findIndex(t => t.id === tickerId);
        if (index !== -1) {
            tickersData[index] = {
                ...tickersData[index],
                ...updates
            };
        }
        
        // Invalidar cache
        localStorage.removeItem('tickers_cache');
        localStorage.removeItem('tickers_cache_time');
        
        console.log(`✅ Ticker actualizado correctamente`);
        
    } catch (error) {
        console.error('Error al actualizar ticker:', error);
        throw error;
    }
}

/**
 * Renderizar tabla de tickers en el modal
 */
export function renderTickersTable() {
    const tbody = document.getElementById('tickersTableBody');
    
    if (!tbody) return;
    
    if (tickersData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No hay tickers registrados</td></tr>';
        return;
    }

    const tickersByCategory = new Map();
    TICKER_CATEGORY_ORDER.forEach((category) => tickersByCategory.set(category, []));

    tickersData.forEach((ticker) => {
        const category = inferTickerCategory(ticker);
        if (!tickersByCategory.has(category)) {
            tickersByCategory.set('otros', []);
        }
        tickersByCategory.get(tickersByCategory.has(category) ? category : 'otros').push(ticker);
    });

    tbody.innerHTML = TICKER_CATEGORY_ORDER
        .filter((category) => (tickersByCategory.get(category) || []).length > 0)
        .map((category) => {
            const rows = tickersByCategory.get(category) || [];
            return `
                <tr class="ticker-group-row">
                    <td colspan="6">${TICKER_CATEGORY_LABELS[category]} <span class="ticker-group-count">${rows.length}</span></td>
                </tr>
                ${rows.map((ticker) => `
                    <tr>
                        <td><strong>${ticker.ticker}</strong></td>
                        <td title="${ticker.nombre}">${getShortTickerName(ticker.nombre)}</td>
                        <td>${renderTickerTypeBadge(category)}</td>
                        <td>${ticker.tickerUsa || '-'}</td>
                        <td>${ticker.ratio}</td>
                        <td>
                            <button class="btn-edit" data-id="${ticker.id}" title="Editar">
                                ✏️
                            </button>
                            <button class="btn-delete" data-id="${ticker.id}" title="Eliminar">
                                🗑️
                            </button>
                        </td>
                    </tr>
                `).join('')}
            `;
        })
        .join('');
    
    // Agregar event listeners a botones de editar
    tbody.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const tickerId = e.currentTarget.dataset.id;
            const ticker = tickersData.find(t => t.id === tickerId);
            
            // Prellenar el formulario con los datos actuales
            document.getElementById('newTicker').value = ticker.ticker;
            document.getElementById('newTicker').disabled = true; // No permitir cambiar el símbolo
            document.getElementById('newNombre').value = ticker.nombre;
            document.getElementById('newTickerUsa').value = ticker.tickerUsa || '';
            document.getElementById('newRatio').value = ticker.ratio;
            
            // Cambiar el botón del formulario
            const submitBtn = document.querySelector('#addTickerForm button[type="submit"]');
            submitBtn.textContent = 'Actualizar Ticker';
            submitBtn.dataset.editId = tickerId;
            
            // Scroll al formulario
            document.getElementById('addTickerForm').scrollIntoView({ behavior: 'smooth' });
        });
    });
    
    // Agregar event listeners a botones de eliminar
    tbody.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const tickerId = e.currentTarget.dataset.id;
            const ticker = tickersData.find(t => t.id === tickerId);
            
            if (confirm(`¿Eliminar ${ticker.ticker}?`)) {
                try {
                    await deleteTicker(tickerId);
                    renderTickersTable();
                } catch (error) {
                    alert('Error al eliminar: ' + error.message);
                }
            }
        });
    });
}

/**
 * Inicializar modal de administración de tickers
 */
export function initTickersModal() {
    const manageTickers = document.getElementById('manageTickers');
    const modal = document.getElementById('tickersModal');
    const closeModal = document.getElementById('closeTickersModal');
    const addForm = document.getElementById('addTickerForm');
    
    // Abrir modal
    manageTickers?.addEventListener('click', async () => {
        setTickersModalState(modal, true);
        await loadTickersFromFirestore();
        renderTickersTable();
    });
    
    // Cerrar modal
    closeModal?.addEventListener('click', () => {
        setTickersModalState(modal, false);
    });
    
    // Cerrar al hacer click fuera del modal
    modal?.addEventListener('click', (e) => {
        if (e.target === modal) {
            setTickersModalState(modal, false);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal?.style.display === 'flex') {
            setTickersModalState(modal, false);
        }
    });
    
    // Agregar/Editar ticker
    addForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const ticker = document.getElementById('newTicker').value.trim().toUpperCase();
        const nombre = document.getElementById('newNombre').value.trim();
        const tickerUsa = document.getElementById('newTickerUsa').value.trim().toUpperCase();
        const ratio = document.getElementById('newRatio').value;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const editId = submitBtn.dataset.editId;
        
        try {
            if (editId) {
                // Modo edición
                await updateTicker(editId, { nombre, tickerUsa, ratio: parseFloat(ratio) });
                
                // Resetear formulario a modo "agregar"
                submitBtn.textContent = 'Agregar Ticker';
                delete submitBtn.dataset.editId;
                document.getElementById('newTicker').disabled = false;
            } else {
                // Modo agregar
                await addTicker(ticker, nombre, ratio, tickerUsa);
            }
            
            renderTickersTable();
            addForm.reset();
            document.getElementById('newTicker').disabled = false;
            document.getElementById('newRatio').value = '1'; // Resetear ratio a 1
        } catch (error) {
            alert('Error: ' + error.message);
        }
    });
}
