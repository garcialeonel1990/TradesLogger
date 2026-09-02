// Importar funciones de Firebase Auth
import { initAuth, login, logout, register, getCurrentUser, isAuthenticated } from './auth/firebase-auth.js';
// Importar funciones de gestión de tickers
import { loadTickersFromFirestore, initTickersModal } from './managers/tickers-manager.js';
import { tickersData } from './managers/tickers-manager.js';
// Importar funciones de gestión de trades
import { saveTrade, getUserTrades, getTradesByTicker, deleteTrade, updateTrade } from './managers/trades-manager.js';

// Variables globales
const form = document.getElementById('tradeForm');
let tradesContainer;
let refreshBtn;
let loadingEl;
let errorEl;
let exportTradesCsvBtn;
const loginScreen = document.getElementById('loginScreen');
const mainApp = document.getElementById('mainApp');
const logoutBtn = document.getElementById('logoutBtn');
const loginForm = document.getElementById('loginForm');
let refreshStatusEl;
let latestTrades = [];
let latestTradesPromise = null;
let latestTradesLoaded = false;
let guardandoTrade = false;
let ultimoTradeIntento = null;
const DUPLICATE_TRADE_WINDOW_MS = 5000;
let cedearSyncPromise = null;
let iolImportRows = [];
let iolImportProcessing = false;
const STOCK_PRICES_CACHE_MS = 60 * 1000;
const stockPricesCache = new Map();
const IOL_EXCLUDED_TICKERS = new Set([
    'AL30',
    'AL30D'
]);
const IOL_IMPORT_LOG_PREFIX = '[IOL Import]';
let ultimoPrecioAutomatico = null;

// Variable para el usuario actual
let currentUser = null;
let tradesRenderizados = false;
let openTradesRendered = false;
let misTradesRendered = false;
const lazyModules = {};

function resetTradesState() {
    latestTrades = [];
    latestTradesPromise = null;
    latestTradesLoaded = false;
    tradesRenderizados = false;
    openTradesRendered = false;
    misTradesRendered = false;
}

async function ensureLatestTrades(options = {}) {
    const force = options.force === true;
    if (!currentUser) {
        return [];
    }

    if (!force && latestTradesLoaded) {
        return latestTrades;
    }

    if (!force && latestTradesPromise) {
        return latestTradesPromise;
    }

    latestTradesPromise = getUserTrades()
        .then((trades) => {
            latestTrades = Array.isArray(trades) ? [...trades] : [];
            latestTradesLoaded = true;
            return latestTrades;
        })
        .finally(() => {
            latestTradesPromise = null;
        });

    return latestTradesPromise;
}

async function refreshTradesData() {
    await ensureLatestTrades({ force: true });
    await loadTrades(Promise.resolve(latestTrades));
}

async function loadTabModule(tabName, options = {}) {
    try {
        if (tabName === 'cauciones') {
            lazyModules.cauciones ||= import('./cauciones-dashboard.js');
            await lazyModules.cauciones;
            return window.cargarDashboardCauciones?.(options.force);
        }

        if (tabName === 'crypto') {
            lazyModules.crypto ||= import('./crypto-dashboard.js');
            const module = await lazyModules.crypto;
            return module.openCryptoDashboard?.();
        }
    } catch (error) {
        console.error(`Error cargando módulo de ${tabName}:`, error);
    }
}

// Aplica ventas con lógica LIFO sobre un arreglo de trades ordenados por fecha asc
function aplicarLifo(trades) {
    const compras = [];
    const ventas = [];
    const ventasPorCompra = []; // Mapeo de qué ventas afectaron a cada compra
    
    trades.forEach(trade => {
        if (trade.tipo.toLowerCase() === 'compra') {
            compras.push({ ...trade, cantidadRestante: trade.cantidad });
            ventasPorCompra.push([]); // Array vacío de ventas para esta compra
        } else {
            ventas.push(trade);
            let cantidadVendida = trade.cantidad;
            // LIFO: descontar de las compras más recientes
            for (let i = compras.length - 1; i >= 0 && cantidadVendida > 0; i--) {
                const compra = compras[i];
                const cantidadADescontar = Math.min(compra.cantidadRestante, cantidadVendida);
                if (cantidadADescontar > 0) {
                    compra.cantidadRestante -= cantidadADescontar;
                    cantidadVendida -= cantidadADescontar;
                    // Registrar esta venta parcial para esta compra
                    ventasPorCompra[i].push({
                        ...trade,
                        cantidadUsada: cantidadADescontar
                    });
                }
            }
        }
    });
    return { compras, ventas, ventasPorCompra };
}

/**
 * Buscar ticker por símbolo o nombre (flexible, case-insensitive)
 * @param {string} search - Texto de búsqueda
 * @returns {string|null} - Símbolo del ticker encontrado o null
 */
function findTickerSymbol(search) {
    if (!search) return null;
    
    const searchUpper = normalizeTickerInput(search);
    
    // 1. Búsqueda exacta por ticker
    let found = tickersData.find(t => t.ticker.toUpperCase() === searchUpper);
    if (found) return found.ticker.toUpperCase(); // SIEMPRE devolver en mayúsculas
    
    // 2. Búsqueda exacta por nombre (case-insensitive)
    found = tickersData.find(t => t.nombre.toUpperCase() === searchUpper);
    if (found) return found.ticker.toUpperCase(); // SIEMPRE devolver en mayúsculas
    
    // 3. Búsqueda parcial por ticker (empieza con...)
    found = tickersData.find(t => t.ticker.toUpperCase().startsWith(searchUpper));
    if (found) return found.ticker.toUpperCase(); // SIEMPRE devolver en mayúsculas
    
    // 4. Búsqueda parcial por nombre (contiene...)
    found = tickersData.find(t => t.nombre.toUpperCase().includes(searchUpper));
    if (found) return found.ticker.toUpperCase(); // SIEMPRE devolver en mayúsculas
    
    // 5. Si no se encuentra, devolver el input original en mayúsculas
    return searchUpper;
}

function normalizeTickerInput(value) {
    const ticker = String(value || '').trim().toUpperCase();
    return ticker.endsWith('.C') ? ticker.replace(/\.C$/, 'C') : ticker;
}

function getActiveTabName() {
    return document.querySelector('.tab-content.active')?.id || 'dashboard';
}

function findTickerInfo(ticker) {
    const normalizedTicker = normalizeTickerInput(ticker);
    return tickersData.find((item) => item.ticker?.toUpperCase() === normalizedTicker) || null;
}

function getTickerUsa(tickerInfo) {
    const tickerUsa = tickerInfo?.tickerUsa;
    return tickerUsa ? normalizeTickerInput(tickerUsa) : null;
}

function getShortTickerReferenceName(name) {
    const normalized = String(name || '').trim();
    if (!normalized) return 'Nombre no disponible';

    const compact = normalized
        .replace(/\bS\.?A\.?\b/gi, '')
        .replace(/\bADR\b/gi, '')
        .replace(/\bHOLDINGS?\b/gi, '')
        .replace(/\bCORPORATION\b/gi, 'Corp')
        .replace(/\bCOMPANY\b/gi, 'Co')
        .replace(/\bBANCO\b/gi, 'Bco')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return compact.length > 24 ? `${compact.slice(0, 24).trim()}...` : compact;
}

function getCedearMetadata(ticker) {
    const tickerInfo = findTickerInfo(ticker);
    if (!tickerInfo) {
        return {
            ok: false,
            reason: 'ticker-no-registrado',
            message: `Ticker CEDEAR no registrado: ${ticker}`
        };
    }

    const ratio = Number(tickerInfo.ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
        return {
            ok: false,
            reason: 'ratio-faltante',
            message: `Falta ratio CEDEAR para ${tickerInfo.ticker}. Cargá el ratio antes de guardar la operación.`
        };
    }

    const tickerUsa = getTickerUsa(tickerInfo);
    if (!tickerUsa) {
        return {
            ok: false,
            reason: 'ticker-usa-faltante',
            message: `Falta ticker USA para ${tickerInfo.ticker}`
        };
    }

    return {
        ok: true,
        cedearTicker: tickerInfo.ticker.toUpperCase(),
        tickerUsa,
        ratio
    };
}

// Limpiar formulario de trade
function resetTradeForm() {
    form.reset();
    
    // Restablecer fecha actual
    const hoy = new Date();
    const year = hoy.getFullYear();
    const month = String(hoy.getMonth() + 1).padStart(2, '0');
    const day = String(hoy.getDate()).padStart(2, '0');
    document.getElementById('fecha').value = `${year}-${month}-${day}`;
    
    // Restablecer hora a la hora actual más cercana (15 min)
    populateHoraSelect();
    
    // Ocultar campo de precio
    document.getElementById('precioGroup').style.display = 'none';
    document.getElementById('precioManual').value = '';
    document.getElementById('precioDisplay').value = '';
    ultimoPrecioAutomatico = null;
    
    // Remover clase active de botones de tipo
    document.querySelectorAll('.btn-tipo').forEach(btn => btn.classList.remove('active'));
}

// Poblar el selector de horas con intervalos de 15 minutos (horario de mercado Argentina)
function populateHoraSelect() {
    const horaSelect = document.getElementById('hora');
    horaSelect.innerHTML = '';
    
    // Opción por defecto: Hora actual
    const defaultOption = document.createElement('option');
    defaultOption.value = 'actual';
    defaultOption.textContent = 'Precio Actual';
    horaSelect.appendChild(defaultOption);
    
    // Horario de mercado Argentina: 11:00 - 18:00 hs
    const startHour = 11;
    const startMinute = 0;
    const endHour = 18;
    const endMinute = 0;
    
    let hour = startHour;
    let minute = startMinute;
    
    while (hour < endHour || (hour === endHour && minute === 0)) {
        const hourStr = String(hour).padStart(2, '0');
        const minuteStr = String(minute).padStart(2, '0');
        const timeValue = `${hourStr}:${minuteStr}`;
        
        // Formato de display (24 horas)
        const displayTime = `${hourStr}:${minuteStr}`;
        
        const option = document.createElement('option');
        option.value = timeValue;
        option.textContent = displayTime;
        horaSelect.appendChild(option);
        
        // Incrementar 15 minutos
        minute += 15;
        if (minute >= 60) {
            minute = 0;
            hour++;
        }
    }
    
    // Seleccionar "Hora actual" por defecto
    horaSelect.value = 'actual';
}

// Mostrar la aplicación después del login
async function showApp() {
    // Agregar animación de fade out al login
    loginScreen.style.transition = 'opacity 0.3s ease-out';
    loginScreen.style.opacity = '0';
    
    setTimeout(() => {
        loginScreen.style.display = 'none';
        mainApp.style.display = 'block';
        mainApp.style.opacity = '0';
        mainApp.style.transition = 'opacity 0.3s ease-in';
        
        // Fade in del main app
        requestAnimationFrame(() => {
            mainApp.style.opacity = '1';
        });
    }, 300);
    
    // Mostrar nombre del usuario
    document.getElementById('userName').textContent = currentUser.name;
    
    // Establecer la fecha actual por defecto
    const hoy = new Date();
    const year = hoy.getFullYear();
    const month = String(hoy.getMonth() + 1).padStart(2, '0');
    const day = String(hoy.getDate()).padStart(2, '0');
    document.getElementById('fecha').value = `${year}-${month}-${day}`;
    
    // Poblar selector de horas
    populateHoraSelect();

    // #2: Disparar la lectura de trades EN PARALELO con la de tickers.
    // getUserTrades() no depende de los tickers, así no esperamos en serie.
    const tradesPromise = ensureLatestTrades({ force: true }).catch((e) => {
        console.error('Error precargando trades:', e);
        return [];
    });

    // Cargar tickers desde Firestore (necesarios para los ratios del dashboard)
    await loadTickersData();
    runCedearSyncIfStale(tradesPromise);

    // Verificar si hay un tab específico para abrir desde sessionStorage
    const openTab = sessionStorage.getItem('openTab');
    let tabToOpen = 'dashboard'; // Por defecto
    
    if (openTab) {
        tabToOpen = openTab;
        sessionStorage.removeItem('openTab'); // Limpiar después de usar
    }
    
    // Activar tab
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    const dashboardBtn = document.querySelector(`[data-tab="${tabToOpen}"]`);
    const dashboardContent = document.getElementById(tabToOpen);
    
    if (dashboardBtn && dashboardContent) {
        dashboardBtn.classList.add('active');
        dashboardContent.classList.add('active');
        loadTabModule(tabToOpen);
        // Cargar trades del dashboard (reutiliza la promesa ya iniciada) y hacer scroll
        loadTrades(tradesPromise).then(() => {
            if (window.innerWidth <= 768) {
                setTimeout(() => {
                    dashboardContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 100);
            }
        });
    }
}

async function runCedearSyncIfStale(tradesPromise = null) {
    if (cedearSyncPromise) {
        return cedearSyncPromise;
    }

    cedearSyncPromise = (async () => {
        try {
            showRefreshStatus(true, 'Verificando master de CEDEARs...');

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const idToken = await window.firebaseAuth?.currentUser?.getIdToken();
            if (!idToken) {
                throw new Error('Usuario no autenticado');
            }

            const response = await fetch('/api/cedear-sync?mode=auto', {
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${idToken}`
                }
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (!data.ok) {
                throw new Error(data.details || 'No se pudo verificar la master de CEDEARs');
            }

            if (!data.applied) {
                return data;
            }

            await loadTickersData();

            const ratioChangedTickers = Array.isArray(data.ratioChangedTickers) ? data.ratioChangedTickers : [];
            if (ratioChangedTickers.length === 0) {
                showSuccess(`Master CEDEAR actualizada (${data.appliedCount || 0} cambios).`);
                return data;
            }

            const trades = await (tradesPromise || Promise.resolve(latestTrades));
            const userTickers = new Set(
                (Array.isArray(trades) ? trades : [])
                    .map((trade) => normalizeTickerInput(trade.ticker))
                    .filter(Boolean)
            );
            const impacted = ratioChangedTickers.filter((ticker) => userTickers.has(normalizeTickerInput(ticker)));

            if (impacted.length > 0) {
                showWarning(`Se actualizaron ratios de CEDEARs que operaste: ${impacted.join(', ')}. Falta aplicar el ajuste de cantidades historicas.`);
            } else {
                showSuccess(`Master CEDEAR actualizada. Cambios de ratio: ${ratioChangedTickers.join(', ')}`);
            }

            return data;
        } catch (error) {
            console.warn('No se pudo verificar la master de CEDEARs al ingresar:', error);
            return null;
        } finally {
            showRefreshStatus(false);
            cedearSyncPromise = null;
        }
    })();

    return cedearSyncPromise;
}

// Manejar cierre de sesión
async function handleLogout() {
    const result = await logout();
    
    if (result.success) {
        // Firebase maneja el cambio de estado automáticamente
        // La función onAuthStateChanged se encargará de mostrar el login
        
        // Limpiar formularios
        form.reset();
        loginForm.reset();
    } else {
        showError('Error al cerrar sesión');
    }
}

// Verificar sesión existente al cargar
document.addEventListener('DOMContentLoaded', () => {
    // Inicializar elementos del DOM
    tradesContainer = document.getElementById('tradesContainer');
    refreshBtn = document.getElementById('refreshBtn');
    loadingEl = document.getElementById('loading');
    errorEl = document.getElementById('error');
    exportTradesCsvBtn = document.getElementById('exportTradesCsvBtn');
    
    // Inicializar Firebase Auth y esperar por cambios de estado
    initAuth((user) => {
        if (user) {
            if (currentUser?.uid !== user.uid) {
                resetTradesState();
            }
            currentUser = user;
            showApp();
        } else {
            currentUser = null;
            resetTradesState();
            showRefreshStatus(false);
            loginScreen.style.display = 'flex';
            mainApp.style.display = 'none';
        }
    });
    
    // Event listener para el dropdown de usuario
    const userButton = document.getElementById('userButton');
    const userMenu = document.getElementById('userMenu');
    
    if (userButton && userMenu) {
        userButton.addEventListener('click', (e) => {
            e.stopPropagation();
            userMenu.classList.toggle('show');
        });
        
        // Cerrar dropdown al hacer click fuera
        document.addEventListener('click', () => {
            userMenu.classList.remove('show');
        });
        
        // Prevenir que el click en el menú cierre el dropdown
        userMenu.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }
    
    // Event listener para las pestañas
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            
            // Remover clase active de todos los botones y contenidos
            tabBtns.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            
            // Agregar clase active al botón y contenido seleccionado
            this.classList.add('active');
            document.getElementById(tabName).classList.add('active');
            loadTabModule(tabName);
            renderTabContentIfNeeded(tabName);
            
            // Scroll en mobile
            if (window.innerWidth <= 768) {
                setTimeout(() => {
                    const tabContent = document.getElementById(tabName);
                    if (tabContent) {
                        tabContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }, 100);
            }
        });
    });
    
    // Event listener para el login
    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const username = document.getElementById('email').value.trim().toLowerCase();
        const password = document.getElementById('password').value;
        const loginBtn = document.getElementById('loginBtn');
        const loginError = document.getElementById('loginError');
        
        // Convertir username a email automáticamente
        const email = username.includes('@') ? username : `${username}@gmail.com`;
        
        // Deshabilitar botón mientras procesa
        loginBtn.disabled = true;
        loginBtn.textContent = 'Iniciando sesión...';
        loginError.textContent = '';
        
        const result = await login(email, password);
        
        if (result.success) {
            // Login exitoso - Firebase maneja el cambio de estado
            loginForm.reset();
            loginError.textContent = '';
        } else {
            // Login fallido
            loginError.textContent = '❌ ' + result.error;
            document.getElementById('password').value = '';
        }
        
        // Rehabilitar botón
        loginBtn.disabled = false;
        loginBtn.textContent = 'Iniciar Sesión';
    });
    
    // Inicializar modal de tickers
    initTickersModal();
    
    // Event listeners
    form.addEventListener('submit', handleSubmit);
    exportTradesCsvBtn?.addEventListener('click', handleExportTradesCsv);
    initIolImportListeners();
    refreshBtn.addEventListener('click', async () => {
        // Verificar qué pestaña está activa
        const activeTab = document.querySelector('.tab-content.active')?.id;
        console.log('[Refresh] Pestaña activa:', activeTab);
        
        if (activeTab === 'cauciones') {
            // Recargar dashboard de cauciones
            console.log('[Refresh] Recargando cauciones...');
            await loadTabModule('cauciones', { force: true });
            if (window.cargarDashboardCauciones) {
                console.log('[Refresh] Cauciones recargadas');
            } else {
                console.error('[Refresh] función cargarDashboardCauciones no disponible');
            }
        } else {
            // Cargar trades actualizados
            console.log('[Refresh] Recargando trades...');
            stockPricesCache.clear();
            await refreshTradesData();
        }
    });
    logoutBtn.addEventListener('click', handleLogout);
    
    // Event listeners para botones de tipo
    const tipoBtns = document.querySelectorAll('.btn-tipo');
    const tipoInput = document.getElementById('tipo');
    
    tipoBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // Remover clase active de todos los botones
            tipoBtns.forEach(b => b.classList.remove('active'));
            
            // Agregar clase active al botón seleccionado
            this.classList.add('active');
            
            // Establecer el valor en el input oculto
            tipoInput.value = this.getAttribute('data-tipo');
        });
    });
    
    // Event listeners para obtener precio automáticamente
    const fechaInput = document.getElementById('fecha');
    const horaInput = document.getElementById('hora');
    const tickerInput = document.getElementById('ticker');
    const tickerNameDisplay = document.getElementById('tickerName');
    const precioGroup = document.getElementById('precioGroup');
    const precioDisplay = document.getElementById('precioDisplay');
    const precioManual = document.getElementById('precioManual');
    const precioStatus = document.getElementById('precioStatus');
    const precioInfo = document.getElementById('precioInfo');
    
    // Debounce para búsqueda de precios
    let precioTimeout;
    
    // Event listener para mostrar sugerencia del ticker (sin autocompletar automáticamente)
    tickerInput.addEventListener('input', function() {
        const inputValue = this.value.trim();
        
        if (!inputValue) {
            tickerNameDisplay.style.display = 'none';
            tickerNameDisplay.textContent = '';
            return;
        }
        
        // Buscar el ticker
        const tickerSymbol = findTickerSymbol(inputValue);
        
        if (tickerSymbol) {
            // Encontró el ticker - mostrar sugerencia
            const tickerInfo = tickersData.find(t => t.ticker === tickerSymbol);
            
            if (tickerInfo) {
                // Mostrar una referencia compacta para que no ocupe tanto espacio
                tickerNameDisplay.textContent = `💡 ${tickerInfo.ticker} - ${getShortTickerReferenceName(tickerInfo.nombre)}`;
                tickerNameDisplay.style.display = 'block';
                tickerNameDisplay.style.color = '#2196F3';
            }
        } else {
            // No encontró el ticker
            tickerNameDisplay.textContent = '✗ Ticker no encontrado';
            tickerNameDisplay.style.display = 'block';
            tickerNameDisplay.style.color = '#ef4444';
        }
    });
    
    // Autocompletar cuando sale del campo (blur)
    tickerInput.addEventListener('blur', function() {
        const inputValue = this.value.trim();
        
        if (!inputValue) {
            tickerNameDisplay.style.display = 'none';
            return;
        }
        
        const tickerSymbol = findTickerSymbol(inputValue);
        
        if (tickerSymbol) {
            const tickerInfo = tickersData.find(t => t.ticker === tickerSymbol);
            if (tickerInfo) {
                console.log('🎯 tickerInfo encontrado:', tickerInfo);
                // Autocompletar con el símbolo correcto
                this.value = tickerInfo.ticker;
                tickerNameDisplay.textContent = `✓ ${getShortTickerReferenceName(tickerInfo.nombre || tickerInfo.name)}`;
                tickerNameDisplay.style.color = '#10b981';
            }
        }
    });
    
    // Función para obtener precio automáticamente con debounce
    async function fetchPrecioAutomatico() {
        clearTimeout(precioTimeout);
        
        precioTimeout = setTimeout(async () => {
            const fecha = fechaInput.value;
            const hora = horaInput.value;
            const tickerInputValue = tickerInput.value.trim();
            
            console.log('🔍 fetchPrecioAutomatico:', { fecha, hora, tickerInput: tickerInputValue });
            
            // Necesitamos fecha, hora y ticker
        if (!fecha || !hora || !tickerInputValue) {
            precioGroup.style.display = 'none';
            ultimoPrecioAutomatico = null;
            return;
        }
        
        // Buscar el símbolo del ticker
        const ticker = findTickerSymbol(tickerInputValue);
        
        console.log('🎯 Ticker resuelto:', { input: tickerInputValue, ticker });
        
        // Necesitamos fecha, hora y ticker
        if (!fecha || !hora || !ticker) {
            precioGroup.style.display = 'none';
            ultimoPrecioAutomatico = null;
            return;
        }

        const cedearMetadata = getCedearMetadata(ticker);
        if (!cedearMetadata.ok) {
            precioGroup.style.display = 'block';
            precioDisplay.value = 'Error';
            precioStatus.textContent = '❌';
            precioInfo.textContent = cedearMetadata.message;
            precioInfo.style.color = '#ef4444';
            precioManual.value = '';
            ultimoPrecioAutomatico = null;
            console.warn('No se puede obtener precio CEDEAR', { ticker, cedearMetadata });
            return;
        }
        
        // Verificar si seleccionó "Hora actual"
        const esPrecioActual = hora === 'actual';
        
        // Si no es "Hora actual", verificar si es fecha y hora actual
        let esHoraActualEspecifica = false;
        if (!esPrecioActual) {
            const fechaActual = new Date();
            const hoy = `${fechaActual.getFullYear()}-${String(fechaActual.getMonth() + 1).padStart(2, '0')}-${String(fechaActual.getDate()).padStart(2, '0')}`;
            const horaActual = `${String(fechaActual.getHours()).padStart(2, '0')}:${String(Math.floor(fechaActual.getMinutes() / 15) * 15).padStart(2, '0')}`;
            
            const esFechaActual = fecha === hoy;
            esHoraActualEspecifica = esFechaActual && hora === horaActual;
        }
        
        // Mostrar el grupo de precio
        precioGroup.style.display = 'block';
        precioDisplay.value = 'Cargando...';
        precioStatus.textContent = '⏳';
        
        if (esPrecioActual || esHoraActualEspecifica) {
            precioInfo.textContent = `Obteniendo precio actual de ${cedearMetadata.tickerUsa}...`;
        } else {
            precioInfo.textContent = `Obteniendo precio de ${cedearMetadata.tickerUsa} para ${fecha} a las ${hora}...`;
        }
        
        try {
            let url;
            if (esPrecioActual || esHoraActualEspecifica) {
                url = `/api/stock-price?ticker=${encodeURIComponent(cedearMetadata.tickerUsa)}`;
            } else {
                url = `/api/stock-price?ticker=${encodeURIComponent(cedearMetadata.tickerUsa)}&date=${encodeURIComponent(fecha)}&time=${encodeURIComponent(hora)}`;
            }
            
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error('No se pudo obtener el precio');
            }
            
            const data = await response.json();
            
            if (data.price) {
                precioManual.value = data.price;
                precioDisplay.value = `$${data.price.toFixed(2)}`;
                precioStatus.textContent = '✅';
                ultimoPrecioAutomatico = {
                    cedearTicker: cedearMetadata.cedearTicker,
                    tickerUsa: cedearMetadata.tickerUsa,
                    ratio: cedearMetadata.ratio,
                    price: Number(data.price),
                    sourceDate: data.date || fecha || 'current',
                    sourceTime: data.time || hora || 'market',
                    source: data.source || 'yahoo'
                };
                
                if (esPrecioActual || esHoraActualEspecifica) {
                    precioInfo.textContent = `Precio actual de Yahoo Finance (${cedearMetadata.tickerUsa})`;
                } else {
                    precioInfo.textContent = `Precio histórico de Yahoo Finance (${cedearMetadata.tickerUsa})`;
                }
                precioInfo.style.color = '#10b981';
            } else {
                throw new Error('Precio no disponible');
            }
        } catch (error) {
            console.error('Error al obtener precio:', error);
            precioDisplay.value = 'Error';
            precioStatus.textContent = '❌';
            precioInfo.textContent = 'No se pudo obtener el precio. Por favor, inténtalo de nuevo.';
            precioInfo.style.color = '#ef4444';
            precioManual.value = '';
            ultimoPrecioAutomatico = null;
        }
        }, 500); // Debounce de 500ms
    }
    
    // Agregar listeners para cambios en fecha, hora o ticker
    fechaInput.addEventListener('change', fetchPrecioAutomatico);
    horaInput.addEventListener('change', fetchPrecioAutomatico);
    tickerInput.addEventListener('blur', fetchPrecioAutomatico);
    tickerInput.addEventListener('change', fetchPrecioAutomatico);
    tickerInput.addEventListener('input', () => {
        // Disparar solo si tiene al menos 2 caracteres
        if (tickerInput.value.trim().length >= 2) {
            fetchPrecioAutomatico();
        }
    });

});

// Manejar el envío del formulario
async function handleSubmit(e) {
    e.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    const submitBtnText = submitBtn?.textContent || 'Guardar Trade';

    if (guardandoTrade) {
        console.warn('Guardado de trade ignorado: ya hay una operación en curso');
        return;
    }

    if (!currentUser) {
        showError('Debes iniciar sesión para guardar trades');
        return;
    }

    guardandoTrade = true;
    showLoading(true);
    hideError();

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Guardando...';
    }

    try {
        // Validar que se haya seleccionado un tipo
        const tipoInput = document.getElementById('tipo');
        if (!tipoInput.value) {
            alert('⚠️ Por favor, selecciona si es una Compra o Venta');
            console.error('❌ No se seleccionó tipo de trade');
            // Hacer scroll al campo de tipo
            document.querySelector('.tipo-buttons').scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Agregar efecto visual de error
            document.querySelector('.tipo-buttons').classList.add('error-shake');
            setTimeout(() => {
                document.querySelector('.tipo-buttons').classList.remove('error-shake');
            }, 500);
            return;
        }

        const tickerInput = document.getElementById('ticker');

        const inputRaw = tickerInput.value.trim();
        if (!inputRaw) {
            alert('⚠️ Por favor, ingresa un ticker válido');
            return;
        }

        // Buscar el símbolo del ticker usando la función flexible
        const tickerBuscado = findTickerSymbol(inputRaw);

        console.log('🎯 Ticker para guardar:', { input: inputRaw, ticker: tickerBuscado });
        console.log('📊 Tickers disponibles en memoria:', tickersData.map(t => t.ticker));

        // Validar si es venta que haya compra activa
        if (tipoInput.value === 'Venta') {
            const cantidadVenta = parseFloat(document.getElementById('cantidad').value);

            console.log('Validando venta de', cantidadVenta, 'acciones de', tickerBuscado);

            try {
                // Cargar trades del ticker desde Firestore
                const tradesDelTicker = await getTradesByTicker(tickerBuscado);

                console.log('Trades del ticker desde Firestore:', tradesDelTicker);

                if (tradesDelTicker.length === 0) {
                    showWarning(`No tienes acciones de ${tickerBuscado} para vender`);
                    resetTradeForm();
                    return;
                }

                // Aplicar LIFO para obtener compras con cantidad restante
                const { compras } = aplicarLifo(tradesDelTicker);

                console.log('Compras después de LIFO:', compras);

                const cantidadDisponible = compras.reduce((sum, c) => sum + c.cantidadRestante, 0);

                console.log('Cantidad disponible:', cantidadDisponible);

                if (cantidadDisponible === 0) {
                    showWarning(`No tienes acciones de ${tickerBuscado} para vender`);
                    resetTradeForm();
                    return;
                }

                if (cantidadVenta > cantidadDisponible) {
                    showWarning(`Solo tienes ${cantidadDisponible} acciones de ${tickerBuscado} disponibles. Intentas vender ${cantidadVenta}`);
                    resetTradeForm();
                    return;
                }
            } catch (error) {
                console.error('Error al validar venta:', error);
                // Continuar sin validación si hay error
            }
        }

        // Determinar el precio a usar
        const fechaSeleccionada = document.getElementById('fecha').value;
        const horaSeleccionada = document.getElementById('hora').value;
        const precioManualValue = document.getElementById('precioManual').value;
        let precio;

        if (!precioManualValue || parseFloat(precioManualValue) <= 0) {
            alert('⚠️ Esperando precio automático. Por favor, asegúrate de haber seleccionado fecha, hora y ticker.');
            console.error('❌ Precio no válido o vacío');
            return;
        }

        const precioUSD = parseFloat(precioManualValue);

        const cedearMetadata = getCedearMetadata(tickerBuscado);
        if (!cedearMetadata.ok) {
            alert(`⚠️ ${cedearMetadata.message}`);
            console.error('❌ Metadata CEDEAR faltante o inválida', { ticker: tickerBuscado, cedearMetadata });
            return;
        }

        if (
            !ultimoPrecioAutomatico ||
            ultimoPrecioAutomatico.cedearTicker !== cedearMetadata.cedearTicker ||
            ultimoPrecioAutomatico.tickerUsa !== cedearMetadata.tickerUsa ||
            Number(ultimoPrecioAutomatico.price) !== precioUSD
        ) {
            alert('⚠️ El precio automático no coincide con el ticker seleccionado. Volvé a cargar el precio antes de guardar.');
            console.error('❌ Precio automático inconsistente', {
                ticker: tickerBuscado,
                cedearMetadata,
                ultimoPrecioAutomatico,
                precioUSD
            });
            return;
        }

        // Dividir precio USD por el ratio para obtener precio CEDEAR
        precio = precioUSD / cedearMetadata.ratio;
        console.log(
            `Precio ${cedearMetadata.tickerUsa} USA: ${precioUSD}, Ratio: ${cedearMetadata.ratio}, Precio CEDEAR: ${precio.toFixed(6)}`
        );

        const tradeData = {
            fecha: fechaSeleccionada,
            hora: horaSeleccionada,
            ticker: cedearMetadata.cedearTicker,
            tipo: tipoInput.value,
            cantidad: parseFloat(document.getElementById('cantidad').value),
            priceCedear: precio,
            precioAccionUsd: precioUSD,
            ratio: cedearMetadata.ratio,
            tickerUsa: cedearMetadata.tickerUsa,
            precioUsdSourceDate: ultimoPrecioAutomatico.sourceDate,
            precioUsdSourceTime: ultimoPrecioAutomatico.sourceTime,
            precioUsdSource: ultimoPrecioAutomatico.source
        };

        const total = tradeData.cantidad * tradeData.priceCedear;
        const tradeToSave = {
            ...tradeData,
            total: parseFloat(total.toFixed(2))
        };

        console.log('📝 Datos del trade a guardar:', tradeData, 'Total:', total);

        if (esTradeDuplicadoInmediato(tradeToSave)) {
            showWarning('Operación duplicada ignorada. Esperá unos segundos antes de cargar una operación idéntica.');
            console.warn('Guardado de trade ignorado por duplicado inmediato:', tradeToSave);
            return;
        }

        console.log('💾 Intentando guardar trade en Firestore...');

        const success = await saveTrade(tradeToSave);

        if (success) {
            registrarTradeGuardado(tradeToSave);
            showSuccess('Trade guardado correctamente');
            // Limpiar formulario solo después de confirmar guardado exitoso
            resetTradeForm();

            setTimeout(() => {
                refreshTradesData().catch((error) => {
                    console.error('Error refrescando trades tras guardar:', error);
                });
            }, 1000);
        }
    } catch (error) {
        console.error('❌ Error al guardar trade:', error);
        showError('Error al guardar el trade: ' + error.message);
    } finally {
        showLoading(false);
        guardandoTrade = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = submitBtnText;
        }
    }
}

function crearTradeFingerprint(trade) {
    return [
        trade.fecha,
        trade.ticker?.toUpperCase(),
        trade.tipo?.toLowerCase(),
        Number(trade.cantidad).toFixed(8),
        Number(trade.priceCedear).toFixed(8),
        Number(trade.total).toFixed(2)
    ].join('|');
}

function esTradeDuplicadoInmediato(trade) {
    if (!ultimoTradeIntento) return false;

    const mismoTrade = ultimoTradeIntento.fingerprint === crearTradeFingerprint(trade);
    const dentroVentana = Date.now() - ultimoTradeIntento.timestamp < DUPLICATE_TRADE_WINDOW_MS;
    return mismoTrade && dentroVentana;
}

function registrarTradeGuardado(trade) {
    ultimoTradeIntento = {
        fingerprint: crearTradeFingerprint(trade),
        timestamp: Date.now()
    };
}

function initIolImportListeners() {
    const elements = {
        toggle: document.getElementById('toggleIolImport'),
        preview: document.getElementById('previewIolImport'),
        file: document.getElementById('iolImportFile'),
        fileName: document.getElementById('iolImportFileName'),
        textarea: document.getElementById('iolImportText'),
        status: document.getElementById('iolImportStatus'),
        previewContainer: document.getElementById('iolImportPreview')
    };

    console.info(IOL_IMPORT_LOG_PREFIX, 'Inicializando importador', {
        toggle: !!elements.toggle,
        preview: !!elements.preview,
        file: !!elements.file,
        fileName: !!elements.fileName,
        textarea: !!elements.textarea,
        status: !!elements.status,
        previewContainer: !!elements.previewContainer
    });

    if (!elements.toggle || !elements.preview || !elements.file || !elements.textarea) {
        console.warn(IOL_IMPORT_LOG_PREFIX, 'Faltan elementos del importador en el DOM. Revisar deployment/cache.', elements);
    }

    elements.toggle?.addEventListener('click', (event) => {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Click Abrir/Cerrar importador');
        toggleIolImportPanel(event);
    });
    elements.preview?.addEventListener('click', (event) => {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Click Vista previa');
        handlePreviewIolImport(event);
    });
    elements.previewContainer?.addEventListener('click', handleIolPreviewActionClick);
    elements.file?.addEventListener('change', (event) => {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Cambio de archivo', {
            fileName: event.target.files?.[0]?.name,
            fileSize: event.target.files?.[0]?.size
        });
        handleIolImportFileChange(event);
    });
}

function toggleIolImportPanel() {
    const body = document.getElementById('iolImportBody');
    const toggle = document.getElementById('toggleIolImport');
    if (!body || !toggle) return;

    const nextVisible = body.style.display === 'none';
    body.style.display = nextVisible ? 'block' : 'none';
    toggle.textContent = nextVisible ? 'Cerrar importador' : 'Abrir importador';
}

function setIolImportStatus(message, type = '') {
    const status = document.getElementById('iolImportStatus');
    if (!status) return;

    status.textContent = message;
    status.className = `iol-import-status ${type}`.trim();
}

function setIolPreviewLoading(message) {
    const preview = document.getElementById('iolImportPreview');
    if (!preview) return;

    preview.innerHTML = `
        <div class="iol-import-loading">
            <span class="iol-import-spinner" aria-hidden="true"></span>
            <span>${escapeHtml(message)}</span>
        </div>
    `;
}

function normalizeIolDate(value) {
    const text = String(value || '').trim();
    const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (slashMatch) {
        const [, day, month, year] = slashMatch;
        const fullYear = year.length === 2 ? `20${year}` : year;
        return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return text;
    }

    throw new Error(`Fecha inválida: ${value}`);
}

function parseIolPriceArs(value) {
    const text = String(value || '')
        .replace(/\$/g, '')
        .replace(/\s/g, '')
        .trim();

    if (!text) throw new Error('Precio vacío');

    if (text.includes(',')) {
        return Number(text.replace(/\./g, '').replace(',', '.'));
    }

    return Number(text.replace(/\./g, ''));
}

function formatIolImportPrice(value) {
    return String(value ?? '').trim().replace(/\s/g, '');
}

function splitIolLine(line) {
    const clean = line.trim().replace(/^\|\s*/, '').replace(/\s*\|$/, '').replace(/^-\s*/, '');
    if (!clean || /^[-|:\s]+$/.test(clean)) return [];

    if (clean.includes('|')) {
        return clean.split('|').map((part) => part.trim()).filter(Boolean);
    }

    if (clean.includes('\t')) {
        return clean.split('\t').map((part) => part.trim()).filter(Boolean);
    }

    if (clean.includes(';')) {
        return clean.split(';').map((part) => part.trim()).filter(Boolean);
    }

    return clean.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function parseIolImportText(text) {
    const htmlRows = parseIolHtmlTable(text);
    if (htmlRows.length > 0) {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Texto detectado como HTML IOL', {
            rows: htmlRows.length
        });
        return htmlRows;
    }

    const rows = String(text || '')
        .split(/\r?\n/)
        .map((line) => splitIolLine(line))
        .filter((parts) => parts.length >= 5)
        .filter((parts) => !/^fecha$/i.test(parts[0]) && !/^fecha/i.test(parts.join('')))
        .map((parts, index) => {
            const [fechaRaw, tipoRaw, tickerRaw, cantidadRaw, precioRaw] = parts;
            const tipo = tipoRaw.toLowerCase() === 'venta' ? 'Venta' : 'Compra';
            const ticker = findTickerSymbol(tickerRaw);
            if (isIolExcludedTicker(ticker)) return null;

            const cantidad = Number(String(cantidadRaw).replace(',', '.'));
            const precioIolArs = parseIolPriceArs(precioRaw);

            if (!ticker) throw new Error(`Ticker inválido en línea ${index + 1}`);
            if (!Number.isFinite(cantidad) || cantidad <= 0) {
                throw new Error(`Cantidad inválida en línea ${index + 1}`);
            }
            if (!Number.isFinite(precioIolArs) || precioIolArs <= 0) {
                throw new Error(`Precio IOL inválido en línea ${index + 1}`);
            }

            const fecha = normalizeIolDate(fechaRaw);

            return {
                rowId: index + 1,
                fecha,
                tipo,
                ticker,
                cantidad,
                precioIolArs,
                precioIolRaw: precioRaw,
                importKey: createIolImportKey({ fecha, tipo, ticker, cantidad, precioIolArs })
            };
        })
        .filter(Boolean);

    console.info(IOL_IMPORT_LOG_PREFIX, 'Texto parseado como líneas simples', {
        rows: rows.length
    });
    return rows;
}

function isIolExcludedTicker(ticker) {
    return IOL_EXCLUDED_TICKERS.has(String(ticker || '').toUpperCase());
}

function parseIolHtmlTable(text) {
    const content = String(text || '');
    if (!/<table[\s>]/i.test(content) || !/Tipo Mov\./i.test(content)) {
        return [];
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    const rows = Array.from(doc.querySelectorAll('tr'));
    const parsedRows = [];
    let rowId = 0;

    rows.forEach((row) => {
        const cells = Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim());
        if (cells.length < 8) return;

        const tipoMov = cells[2] || '';
        const match = tipoMov.match(/^(Compra|Venta)\(([^)]+)\)/i);
        if (!match) return;

        const tipo = match[1].toLowerCase() === 'venta' ? 'Venta' : 'Compra';
        const ticker = findTickerSymbol(match[2]);
        if (isIolExcludedTicker(ticker)) return;

        const fecha = normalizeIolDate(cells[3]);
        const cantidad = parseIolQuantity(cells[6]);
        const precioIolArs = parseIolPriceArs(cells[7]);

        if (!ticker || !Number.isFinite(cantidad) || !Number.isFinite(precioIolArs)) {
            return;
        }

        rowId += 1;
        parsedRows.push({
            rowId,
            fecha,
            tipo,
            ticker,
            cantidad,
            precioIolArs,
            precioIolRaw: cells[7],
            importKey: createIolImportKey({ fecha, tipo, ticker, cantidad, precioIolArs })
        });
    });

    console.info(IOL_IMPORT_LOG_PREFIX, 'HTML IOL parseado', {
        totalRows: rows.length,
        parsedOperations: parsedRows.length,
        excludedTickers: [...IOL_EXCLUDED_TICKERS]
    });
    return parsedRows;
}

function parseIolQuantity(value) {
    const text = String(value || '').replace(/\./g, '').replace(',', '.').trim();
    return Number(text);
}

async function handleIolImportFileChange(event) {
    const file = event.target.files?.[0];
    const textarea = document.getElementById('iolImportText');
    const fileName = document.getElementById('iolImportFileName');
    const preview = document.getElementById('iolImportPreview');

    if (!file || !textarea) {
        if (fileName) {
            fileName.textContent = 'Ningún archivo seleccionado';
            fileName.removeAttribute('title');
        }
        return;
    }

    if (fileName) {
        fileName.textContent = file.name;
        fileName.title = file.name;
    }

    try {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Leyendo archivo', {
            name: file.name,
            size: file.size,
            type: file.type
        });
        setIolImportStatus(`Leyendo ${file.name}...`, 'loading');
        const text = await file.text();
        console.info(IOL_IMPORT_LOG_PREFIX, 'Archivo leído como texto', {
            length: text.length,
            startsWith: text.slice(0, 80)
        });
        const rows = parseIolHtmlTable(text);

        if (rows.length > 0) {
            textarea.value = rows
                .map((row) => `${row.fecha} ${row.tipo} ${row.ticker} ${row.cantidad} ${formatIolImportPrice(row.precioIolRaw)}`)
                .join('\n');
            setIolImportStatus(`Archivo listo: ${rows.length} operaciones de compra/venta encontradas. Tocá Vista previa.`, 'success');
        } else {
            textarea.value = text;
            setIolImportStatus('Archivo leído. Tocá Vista previa para procesarlo.', 'success');
        }

        iolImportRows = [];
        if (preview) preview.innerHTML = '';
    } catch (error) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'Error leyendo archivo IOL', error);
        setIolImportStatus(`No pude leer el archivo: ${error.message}`, 'error');
    }
}

function createIolImportKey(trade) {
    return [
        trade.fecha,
        trade.tipo,
        trade.ticker?.toUpperCase(),
        Number(trade.cantidad).toFixed(8),
        Number(trade.precioIolArs).toFixed(4)
    ].join('|');
}

function getTradeMatchId(trade) {
    const normalized = normalizeTradeData(trade);
    return `${normalized._fechaPath || normalized.fecha || ''}|${normalized.id || ''}`;
}

function findExistingImportedTrade(row, options = {}) {
    const usedTradeIds = options.usedTradeIds || new Set();
    const expectedPriceCedear = Number(options.expectedPriceCedear);
    const importKey = row.importKey;
    const normalizedTrades = latestTrades.map((item) => normalizeTradeData(item));
    const exactImportMatch = normalizedTrades.find((trade) => (
        trade.importKey === importKey && !usedTradeIds.has(getTradeMatchId(trade))
    ));

    if (exactImportMatch) {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Trade existente por importKey', {
            ticker: row.ticker,
            fecha: row.fecha,
            tipo: row.tipo,
            cantidad: row.cantidad,
            existingId: exactImportMatch.id
        });
        return exactImportMatch;
    }

    const candidates = normalizedTrades
        .filter((trade) => (
            !usedTradeIds.has(getTradeMatchId(trade)) &&
            trade.fecha === row.fecha &&
            trade.ticker?.toUpperCase() === row.ticker?.toUpperCase() &&
            trade.tipo?.toLowerCase() === row.tipo.toLowerCase() &&
            Number(trade.cantidad) === Number(row.cantidad)
        ));

    if (candidates.length === 0) return null;

    const looseMatch = Number.isFinite(expectedPriceCedear)
        ? [...candidates].sort((a, b) => (
            Math.abs(Number(a.priceCedear) - expectedPriceCedear) -
            Math.abs(Number(b.priceCedear) - expectedPriceCedear)
        ))[0]
        : candidates[0];

    if (looseMatch) {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Trade existente por fecha/tipo/ticker/cantidad', {
            ticker: row.ticker,
            fecha: row.fecha,
            tipo: row.tipo,
            cantidad: row.cantidad,
            existingId: looseMatch.id,
            candidates: candidates.length,
            expectedPriceCedear: Number.isFinite(expectedPriceCedear) ? expectedPriceCedear : null,
            selectedPriceCedear: looseMatch.priceCedear
        });
    }

    return looseMatch;
}

function getTickerRatio(ticker) {
    const cedearMetadata = getCedearMetadata(ticker);
    return cedearMetadata.ok ? cedearMetadata.ratio : null;
}

async function fetchUnderlyingPriceUsd(ticker, fecha) {
    const cedearMetadata = getCedearMetadata(ticker);
    if (!cedearMetadata.ok) {
        throw new Error(cedearMetadata.message);
    }

    const url = `/api/stock-price?ticker=${encodeURIComponent(cedearMetadata.tickerUsa)}&date=${encodeURIComponent(fecha)}`;
    console.info(IOL_IMPORT_LOG_PREFIX, 'Consultando precio USD', {
        ticker,
        tickerUsa: cedearMetadata.tickerUsa,
        fecha,
        url
    });
    const response = await fetch(url);

    if (!response.ok) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'Error HTTP consultando precio', {
            ticker,
            tickerUsa: cedearMetadata.tickerUsa,
            fecha,
            status: response.status,
            statusText: response.statusText
        });
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.info(IOL_IMPORT_LOG_PREFIX, 'Respuesta precio USD', { ticker, fecha, data });
    const price = Number(data.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error('Precio no disponible');
    }

    return {
        cedearTicker: cedearMetadata.cedearTicker,
        tickerUsa: cedearMetadata.tickerUsa,
        ratio: cedearMetadata.ratio,
        price,
        sourceDate: data.date || fecha,
        source: data.source || 'api'
    };
}

function getImportTimestamp(fecha, index) {
    const [year, month, day] = fecha.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 18, index % 60, 0));
    return date.toISOString();
}

async function handlePreviewIolImport() {
    console.info(IOL_IMPORT_LOG_PREFIX, 'handlePreviewIolImport iniciado', {
        iolImportProcessing,
        currentUser: !!currentUser,
        latestTrades: latestTrades.length
    });

    if (iolImportProcessing) {
        console.warn(IOL_IMPORT_LOG_PREFIX, 'Vista previa ignorada: ya hay un proceso en curso');
        return;
    }

    const textarea = document.getElementById('iolImportText');
    const previewBtn = document.getElementById('previewIolImport');
    const preview = document.getElementById('iolImportPreview');

    if (!textarea || !previewBtn || !preview) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'No se puede iniciar vista previa: faltan elementos DOM', {
            textarea: !!textarea,
            previewBtn: !!previewBtn,
            preview: !!preview
        });
        return;
    }

    iolImportProcessing = true;
    previewBtn.disabled = true;
    iolImportRows = [];
    preview.innerHTML = '';
    setIolImportStatus('Procesando vista previa...', 'loading');
    setIolPreviewLoading('Preparando comparacion contra Firebase y precios USD...');

    try {
        if (!currentUser) {
            throw new Error('Tenés que iniciar sesión para importar');
        }

        if (!latestTradesLoaded) {
            console.info(IOL_IMPORT_LOG_PREFIX, 'latestTrades vacío, cargando desde Firestore');
            await ensureLatestTrades();
            console.info(IOL_IMPORT_LOG_PREFIX, 'Trades cargados para comparar', {
                latestTrades: latestTrades.length
            });
        }

        const parsedRows = parseIolImportText(textarea.value);
        console.info(IOL_IMPORT_LOG_PREFIX, 'Filas parseadas para vista previa', {
            parsedRows: parsedRows.length,
            sample: parsedRows.slice(0, 5)
        });
        if (parsedRows.length === 0) {
            throw new Error('No encontré operaciones válidas para importar');
        }

        iolImportRows = [];
        const usedTradeIds = new Set();
        for (const [index, row] of parsedRows.entries()) {
            const ratio = getTickerRatio(row.ticker);
            const progressMessage = `Procesando ${index + 1}/${parsedRows.length}: ${row.ticker} ${row.tipo} ${row.fecha}`;
            setIolImportStatus(progressMessage, 'loading');
            setIolPreviewLoading(progressMessage);
            console.info(IOL_IMPORT_LOG_PREFIX, 'Procesando fila', {
                rowId: row.rowId,
                fecha: row.fecha,
                tipo: row.tipo,
                ticker: row.ticker,
                cantidad: row.cantidad,
                precioIolArs: row.precioIolArs,
                ratio
            });

            if (!ratio) {
                const existingTrade = findExistingImportedTrade(row, { usedTradeIds });
                if (existingTrade) {
                    usedTradeIds.add(getTradeMatchId(existingTrade));
                }

                if (!existingTrade) {
                    console.warn(IOL_IMPORT_LOG_PREFIX, 'Fila bloqueada por falta de ratio', row);
                    iolImportRows.push({
                        ...row,
                        status: 'missing-ratio',
                        statusLabel: 'Falta ratio (no se importa)'
                    });
                    continue;
                }

                console.warn(IOL_IMPORT_LOG_PREFIX, 'Fila ya cargada pero falta ratio', row);
                iolImportRows.push({
                    ...row,
                    status: 'loaded-missing-ratio',
                    statusLabel: 'Ya cargado (falta ratio)',
                    existingPriceCedear: Number(existingTrade.priceCedear),
                    existingTotal: Number(existingTrade.total),
                    existingTradeId: existingTrade.id,
                    existingFechaPath: existingTrade._fechaPath
                });
                continue;
            }

            try {
                const priceInfo = await fetchUnderlyingPriceUsd(row.ticker, row.fecha);
                const priceCedear = priceInfo.price / priceInfo.ratio;
                const total = priceCedear * row.cantidad;
                const existingTrade = findExistingImportedTrade(row, {
                    usedTradeIds,
                    expectedPriceCedear: priceCedear
                });
                if (existingTrade) {
                    usedTradeIds.add(getTradeMatchId(existingTrade));
                }

                const existingPriceCedear = existingTrade ? Number(existingTrade.priceCedear) : null;
                const existingTotal = existingTrade ? Number(existingTrade.total) : null;
                const priceDiff = existingTrade ? existingPriceCedear - priceCedear : 0;
                const totalDiff = existingTrade ? existingTotal - total : 0;
                const hasPriceDiff = Math.abs(priceDiff) > 0.01;

                iolImportRows.push({
                    ...row,
                    ticker: priceInfo.cedearTicker,
                    tickerUsa: priceInfo.tickerUsa,
                    ratio: priceInfo.ratio,
                    precioAccionUsd: priceInfo.price,
                    precioFechaFuente: priceInfo.sourceDate,
                    precioUsdSource: priceInfo.source,
                    priceCedear,
                    total: Number(total.toFixed(2)),
                    existingPriceCedear,
                    existingTotal,
                    priceDiff,
                    totalDiff,
                    existingTradeId: existingTrade ? existingTrade.id : null,
                    existingFechaPath: existingTrade ? existingTrade._fechaPath : null,
                    status: existingTrade ? 'loaded' : 'new',
                    statusLabel: existingTrade
                        ? (hasPriceDiff ? 'Ya cargado (precio distinto)' : 'Ya cargado')
                        : 'Nuevo'
                });
                console.info(IOL_IMPORT_LOG_PREFIX, 'Fila resuelta', {
                    ticker: row.ticker,
                    fecha: row.fecha,
                    status: existingTrade ? 'loaded' : 'new',
                    priceCedear,
                    total: Number(total.toFixed(2)),
                    priceDiff,
                    totalDiff
                });
            } catch (error) {
                console.error(IOL_IMPORT_LOG_PREFIX, 'Error resolviendo fila', {
                    row,
                    error: error.message
                });
                iolImportRows.push({
                    ...row,
                    ratio,
                    status: 'price-error',
                    statusLabel: 'Error precio',
                    error: error.message
                });
            }
        }

        renderIolImportPreview();
        const nuevos = iolImportRows.filter((row) => row.status === 'new').length;
        const cargados = iolImportRows.filter((row) => row.status === 'loaded' || row.status === 'loaded-missing-ratio').length;
        const actualizables = iolImportRows.filter((row) => shouldShowIolUpdateAction(row)).length;
        const faltanRatio = iolImportRows.filter((row) => row.status === 'missing-ratio').length;
        const bloqueados = iolImportRows.length - nuevos - cargados;
        const tickersSinRatio = [...new Set(
            iolImportRows
                .filter((row) => row.status === 'missing-ratio' || row.status === 'loaded-missing-ratio')
                .map((row) => row.ticker)
        )].join(', ');

        console.info(IOL_IMPORT_LOG_PREFIX, 'Vista previa terminada', {
            total: iolImportRows.length,
            nuevos,
            cargados,
            actualizables,
            faltanRatio,
            bloqueados,
            tickersSinRatio
        });
        const actionMessage = actualizables > 0
            ? ` Actualizá los que tienen precio distinto desde el botón de cada fila.`
            : '';
        setIolImportStatus(
            `Vista previa lista: ${nuevos} nuevos, ${cargados} ya cargados, ${actualizables} para actualizar, ${bloqueados} con revisión. Usá la columna Acción para guardar o actualizar fila por fila.${actionMessage}${faltanRatio > 0 ? ` Falta ratio para: ${tickersSinRatio}.` : ''}`,
            nuevos > 0 || actualizables > 0 ? 'success' : 'warning'
        );
    } catch (error) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'Error en vista previa IOL', error);
        setIolImportStatus(error.message, 'error');
    } finally {
        iolImportProcessing = false;
        previewBtn.disabled = false;
        renderIolImportPreview();
        console.info(IOL_IMPORT_LOG_PREFIX, 'handlePreviewIolImport finalizado');
    }
}

function renderIolImportPreview() {
    const preview = document.getElementById('iolImportPreview');
    if (!preview) return;

    if (iolImportRows.length === 0) {
        preview.innerHTML = '';
        return;
    }

    preview.innerHTML = `
        ${renderIolBulkActions()}
        <div class="iol-import-table-wrap">
            <table class="iol-import-table">
                <colgroup>
                    <col class="iol-col-status">
                    <col class="iol-col-date">
                    <col class="iol-col-type">
                    <col class="iol-col-ticker">
                    <col class="iol-col-qty">
                    <col class="iol-col-money">
                    <col class="iol-col-money">
                    <col class="iol-col-ratio">
                    <col class="iol-col-money">
                    <col class="iol-col-money">
                    <col class="iol-col-diff">
                    <col class="iol-col-money">
                    <col class="iol-col-diff">
                    <col class="iol-col-action">
                </colgroup>
                <thead>
                    <tr>
                        <th>Estado</th>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th>Ticker</th>
                        <th>Cant.</th>
                        <th>IOL ARS</th>
                        <th>USD acción</th>
                        <th>Ratio</th>
                        <th>USD CEDEAR</th>
                        <th>USD cargado</th>
                        <th>Dif. precio</th>
                        <th>Total USD</th>
                        <th>Dif. total</th>
                        <th>Acción</th>
                    </tr>
                </thead>
                <tbody>
                    ${iolImportRows.map((row) => `
                        <tr>
                            <td><span class="iol-status-pill ${row.status} ${row.pendingAction ? 'processing' : ''}" title="${escapeHtml(row.statusLabel)}">${escapeHtml(getIolRowStatusText(row))}</span></td>
                            <td>${escapeHtml(row.fecha)}</td>
                            <td>${escapeHtml(row.tipo)}</td>
                            <td><strong>${escapeHtml(row.ticker)}</strong></td>
                            <td>${formatCantidad(row.cantidad)}</td>
                            <td>$${formatNumber(row.precioIolArs)}</td>
                            <td>${row.precioAccionUsd ? `$${formatNumber(row.precioAccionUsd)}` : '-'}</td>
                            <td>${row.ratio || '-'}</td>
                            <td>${row.priceCedear ? `$${formatNumber(row.priceCedear)}` : '-'}</td>
                            <td>${formatIolOptionalMoney(row.existingPriceCedear)}</td>
                            <td class="${getDiffClass(row.priceDiff)}">${formatIolDiff(row.priceDiff)}</td>
                            <td>${row.total ? `$${formatNumber(row.total)}` : '-'}</td>
                            <td class="${getDiffClass(row.totalDiff)}">${formatIolDiff(row.totalDiff)}</td>
                            <td>${renderIolRowAction(row)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function getIolRowStatusText(row) {
    if (row.pendingAction) return row.pendingAction.replace(/\.+$/, '');
    if (row.error) return row.statusLabel || 'Error';
    if (row.status === 'loaded' && shouldShowIolUpdateAction(row)) return 'Precio distinto';
    if (row.statusLabel === 'Ya cargado') return 'Cargado';
    if (row.statusLabel === 'Ya cargado (precio distinto)') return 'Precio distinto';
    return row.statusLabel;
}

function formatIolOptionalMoney(value) {
    return Number.isFinite(Number(value)) ? `$${formatNumber(Number(value))}` : '-';
}

function formatIolDiff(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    const sign = number > 0 ? '+' : '';
    return `${sign}$${formatNumber(number)}`;
}

function getDiffClass(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) <= 0.01) return 'iol-diff-neutral';
    return number > 0 ? 'iol-diff-positive' : 'iol-diff-negative';
}

function getIolBulkActionRows() {
    return iolImportRows.filter((row) => row.status === 'new' || shouldShowIolUpdateAction(row));
}

function renderIolBulkActions() {
    const nuevos = iolImportRows.filter((row) => row.status === 'new').length;
    const actualizables = iolImportRows.filter((row) => shouldShowIolUpdateAction(row)).length;
    const total = nuevos + actualizables;

    if (total === 0) {
        return '';
    }

    const label = iolImportProcessing
        ? 'Aplicando...'
        : `Aplicar todo (${total})`;
    const detail = [
        nuevos ? `${nuevos} nuevos` : '',
        actualizables ? `${actualizables} actualizaciones` : ''
    ].filter(Boolean).join(' / ');

    return `
        <div class="iol-import-bulk-actions" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0;">
            <span class="iol-row-action-text">${escapeHtml(detail)}</span>
            <button class="iol-update-row-btn" type="button" data-iol-apply-all ${iolImportProcessing ? 'disabled' : ''}>${escapeHtml(label)}</button>
        </div>
    `;
}

function renderIolRowAction(row) {
    if (row.pendingAction) {
        return `<button class="iol-save-row-btn iol-row-action-loading" type="button" disabled>${escapeHtml(row.pendingAction)}</button>`;
    }

    if (row.status === 'new') {
        return `<button class="iol-save-row-btn" type="button" data-iol-save-row-id="${row.rowId}" ${iolImportProcessing ? 'disabled' : ''}>Guardar</button>`;
    }

    if (shouldShowIolUpdateAction(row)) {
        return `<button class="iol-update-row-btn" type="button" data-iol-update-row-id="${row.rowId}" ${iolImportProcessing ? 'disabled' : ''}>Actualizar</button>`;
    }

    if (row.status === 'loaded' || row.status === 'loaded-missing-ratio') {
        return '<span class="iol-row-action-text">Cargado</span>';
    }

    return '<span class="iol-row-action-text">-</span>';
}

function shouldShowIolUpdateAction(row) {
    return (
        row.status === 'loaded' &&
        row.existingTradeId &&
        row.existingFechaPath &&
        (
            Math.abs(Number(row.priceDiff)) > 0.01 ||
            Math.abs(Number(row.totalDiff)) > 0.01
        )
    );
}

function handleIolPreviewActionClick(event) {
    const applyAllButton = event.target.closest('[data-iol-apply-all]');
    if (applyAllButton) {
        console.info(IOL_IMPORT_LOG_PREFIX, 'Click Aplicar todo');
        handleApplyAllIolRows();
        return;
    }

    const saveButton = event.target.closest('[data-iol-save-row-id]');
    if (saveButton) {
        const rowId = Number(saveButton.dataset.iolSaveRowId);
        console.info(IOL_IMPORT_LOG_PREFIX, 'Click Guardar fila', { rowId });
        handleImportSingleIolTrade(rowId);
        return;
    }

    const updateButton = event.target.closest('[data-iol-update-row-id]');
    if (updateButton) {
        const rowId = Number(updateButton.dataset.iolUpdateRowId);
        console.info(IOL_IMPORT_LOG_PREFIX, 'Click Actualizar fila', { rowId });
        handleUpdateSingleIolTrade(rowId);
    }
}

function buildIolTradeToSave(row) {
    return {
        fecha: row.fecha,
        hora: '',
        ticker: row.ticker,
        tipo: row.tipo,
        cantidad: row.cantidad,
        priceCedear: row.priceCedear,
        total: row.total,
        timestamp: getImportTimestamp(row.fecha, row.rowId),
        source: 'IOL',
        precioIolArs: row.precioIolArs,
        precioAccionUsd: row.precioAccionUsd,
        ratio: row.ratio,
        tickerUsa: row.tickerUsa,
        precioUsdSourceDate: row.precioFechaFuente,
        precioUsdSource: row.precioUsdSource,
        importKey: row.importKey
    };
}

function buildIolTradeUpdates(row) {
    return {
        priceCedear: row.priceCedear,
        total: row.total,
        source: 'IOL',
        precioIolArs: row.precioIolArs,
        precioAccionUsd: row.precioAccionUsd,
        ratio: row.ratio,
        tickerUsa: row.tickerUsa,
        precioUsdSourceDate: row.precioFechaFuente,
        precioUsdSource: row.precioUsdSource,
        importKey: row.importKey
    };
}

function markIolRowSynced(row, statusLabel) {
    row.status = 'loaded';
    row.statusLabel = statusLabel;
    row.existingPriceCedear = row.priceCedear;
    row.existingTotal = row.total;
    row.priceDiff = 0;
    row.totalDiff = 0;
    delete row.error;
}

async function saveIolRow(row) {
    const tradeToSave = buildIolTradeToSave(row);
    console.info(IOL_IMPORT_LOG_PREFIX, 'Guardando trade importado', tradeToSave);
    await saveTrade(tradeToSave);
    markIolRowSynced(row, 'Importado');
}

async function updateIolRow(row) {
    const updates = buildIolTradeUpdates(row);
    console.info(IOL_IMPORT_LOG_PREFIX, 'Actualizando trade importado', {
        tradeId: row.existingTradeId,
        fechaPath: row.existingFechaPath,
        updates
    });
    await updateTrade(row.existingTradeId, updates, { _fechaPath: row.existingFechaPath });
    markIolRowSynced(row, 'Actualizado');
}

async function handleImportSingleIolTrade(rowId) {
    console.info(IOL_IMPORT_LOG_PREFIX, 'handleImportSingleIolTrade iniciado', {
        rowId,
        iolImportProcessing
    });

    if (iolImportProcessing) {
        console.warn(IOL_IMPORT_LOG_PREFIX, 'Guardado de fila ignorado: ya hay un proceso en curso');
        return;
    }

    const row = iolImportRows.find((item) => Number(item.rowId) === Number(rowId));
    if (!row) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'No encontré la fila para guardar', { rowId });
        setIolImportStatus(`No encontré la fila ${rowId} para guardar`, 'error');
        return;
    }

    if (row.status !== 'new') {
        console.warn(IOL_IMPORT_LOG_PREFIX, 'Fila no importable por estado', {
            rowId,
            status: row.status,
            row
        });
        setIolImportStatus(`La fila ${rowId} no está lista para guardar`, 'warning');
        return;
    }

    iolImportProcessing = true;
    row.pendingAction = 'Guardando...';
    setIolImportStatus(`Guardando ${row.ticker} ${row.tipo} del ${row.fecha}...`, 'loading');
    renderIolImportPreview();

    try {
        await saveIolRow(row);
        setIolImportStatus(`Guardado en Firebase. Actualizando pantalla...`, 'loading');
        console.info(IOL_IMPORT_LOG_PREFIX, 'Trade importado OK', {
            ticker: row.ticker,
            fecha: row.fecha,
            tipo: row.tipo,
            cantidad: row.cantidad
        });

        await ensureLatestTrades({ force: true });
        renderIolImportPreview();
        await loadTrades(Promise.resolve(latestTrades));
        setIolImportStatus(`Trade guardado: ${row.ticker} ${row.tipo} ${formatCantidad(row.cantidad)}.`, 'success');
        showSuccess('Trade IOL guardado');
        console.info(IOL_IMPORT_LOG_PREFIX, 'Guardado individual completo');
    } catch (error) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'Error al guardar fila IOL', { row, error });
        setIolImportStatus(`Error al guardar fila ${rowId}: ${error.message}`, 'error');
    } finally {
        delete row.pendingAction;
        iolImportProcessing = false;
        renderIolImportPreview();
        console.info(IOL_IMPORT_LOG_PREFIX, 'handleImportSingleIolTrade finalizado');
    }
}

async function handleUpdateSingleIolTrade(rowId) {
    console.info(IOL_IMPORT_LOG_PREFIX, 'handleUpdateSingleIolTrade iniciado', {
        rowId,
        iolImportProcessing
    });

    if (iolImportProcessing) {
        console.warn(IOL_IMPORT_LOG_PREFIX, 'Actualización de fila ignorada: ya hay un proceso en curso');
        return;
    }

    const row = iolImportRows.find((item) => Number(item.rowId) === Number(rowId));
    if (!row) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'No encontré la fila para actualizar', { rowId });
        setIolImportStatus(`No encontré la fila ${rowId} para actualizar`, 'error');
        return;
    }

    if (!shouldShowIolUpdateAction(row)) {
        console.warn(IOL_IMPORT_LOG_PREFIX, 'Fila no actualizable por estado/diferencia', {
            rowId,
            status: row.status,
            row
        });
        setIolImportStatus(`La fila ${rowId} no está lista para actualizar`, 'warning');
        return;
    }

    iolImportProcessing = true;
    row.pendingAction = 'Actualizando...';
    setIolImportStatus(`Actualizando ${row.ticker} ${row.tipo} del ${row.fecha}...`, 'loading');
    renderIolImportPreview();

    try {
        await updateIolRow(row);
        setIolImportStatus(`Actualizado en Firebase. Actualizando pantalla...`, 'loading');
        console.info(IOL_IMPORT_LOG_PREFIX, 'Trade actualizado OK', {
            ticker: row.ticker,
            fecha: row.fecha,
            tipo: row.tipo,
            cantidad: row.cantidad
        });

        await ensureLatestTrades({ force: true });
        renderIolImportPreview();
        await loadTrades(Promise.resolve(latestTrades));
        setIolImportStatus(`Trade actualizado: ${row.ticker} ${row.tipo} ${formatCantidad(row.cantidad)}.`, 'success');
        showSuccess('Trade IOL actualizado');
    } catch (error) {
        console.error(IOL_IMPORT_LOG_PREFIX, 'Error al actualizar fila IOL', { row, error });
        setIolImportStatus(`Error al actualizar fila ${rowId}: ${error.message}`, 'error');
    } finally {
        delete row.pendingAction;
        iolImportProcessing = false;
        renderIolImportPreview();
        console.info(IOL_IMPORT_LOG_PREFIX, 'handleUpdateSingleIolTrade finalizado');
    }
}

async function handleApplyAllIolRows() {
    console.info(IOL_IMPORT_LOG_PREFIX, 'handleApplyAllIolRows iniciado', {
        iolImportProcessing
    });

    if (iolImportProcessing) {
        console.warn(IOL_IMPORT_LOG_PREFIX, 'Aplicar todo ignorado: ya hay un proceso en curso');
        return;
    }

    const rows = getIolBulkActionRows();
    if (rows.length === 0) {
        setIolImportStatus('No hay filas listas para aplicar.', 'warning');
        return;
    }

    const nuevos = rows.filter((row) => row.status === 'new').length;
    const actualizables = rows.filter((row) => shouldShowIolUpdateAction(row)).length;
    const confirmation = [
        nuevos ? `${nuevos} operaciones nuevas` : '',
        actualizables ? `${actualizables} operaciones con precio distinto` : ''
    ].filter(Boolean).join(' y ');

    if (!confirm(`¿Aplicar ${confirmation}? Se van a tocar solo los datos USD calculados y las operaciones nuevas del CSV.`)) {
        return;
    }

    iolImportProcessing = true;
    let saved = 0;
    let updated = 0;
    const errors = [];

    try {
        for (const [index, row] of rows.entries()) {
            const action = row.status === 'new' ? 'Guardando' : 'Actualizando';
            row.pendingAction = `${action}...`;
            setIolImportStatus(`${action} ${index + 1}/${rows.length}: ${row.ticker} ${row.tipo} ${row.fecha}`, 'loading');
            renderIolImportPreview();

            try {
                if (row.status === 'new') {
                    await saveIolRow(row);
                    saved += 1;
                } else if (shouldShowIolUpdateAction(row)) {
                    await updateIolRow(row);
                    updated += 1;
                }
            } catch (error) {
                row.statusLabel = 'Error al aplicar';
                row.error = error.message;
                errors.push({
                    row,
                    error
                });
                console.error(IOL_IMPORT_LOG_PREFIX, 'Error aplicando fila IOL', { row, error });
            } finally {
                delete row.pendingAction;
            }
        }

        await ensureLatestTrades({ force: true });
        renderIolImportPreview();
        await loadTrades(Promise.resolve(latestTrades));

        if (errors.length > 0) {
            setIolImportStatus(`Aplicación parcial: ${saved} guardadas, ${updated} actualizadas, ${errors.length} con error. Revisá las filas marcadas.`, 'warning');
            showWarning('Importación IOL aplicada parcialmente');
        } else {
            setIolImportStatus(`Aplicación completa: ${saved} guardadas y ${updated} actualizadas.`, 'success');
            showSuccess('Importación IOL aplicada');
        }
    } finally {
        iolImportProcessing = false;
        iolImportRows.forEach((row) => delete row.pendingAction);
        renderIolImportPreview();
        console.info(IOL_IMPORT_LOG_PREFIX, 'handleApplyAllIolRows finalizado', {
            saved,
            updated,
            errors: errors.length
        });
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// =====================================================
// GESTIÓN DE TICKERS Y TRADES
// =====================================================

// Cargar tickers desde Firestore
async function loadTickersData() {
    try {
        await loadTickersFromFirestore();
    } catch (error) {
        console.error('Error al cargar datos de tickers:', error);
    }
}

// Cargar trades desde Firestore
async function loadTrades(tradesPromise = null) {
    if (!currentUser) {
        showError('Debes iniciar sesión para ver los trades');
        return;
    }

    const primeraCarga = !tradesRenderizados;

    if (primeraCarga && tradesContainer) {
        tradesContainer.innerHTML = '<div class="loading-placeholder">Cargando trades...</div>';
    }
    const dashboardContent = document.getElementById('dashboardContent');
    if (primeraCarga && dashboardContent) {
        dashboardContent.innerHTML = '<p style="text-align:center;color:#888;padding:40px 16px;">Cargando datos de Firestore...</p>';
    } else {
        showRefreshStatus(true);
    }
    
    try {
        showLoading(primeraCarga);
        hideError();

        // Si recibimos una promesa ya iniciada (carga en paralelo), la reutilizamos
        const trades = await (tradesPromise || ensureLatestTrades());
        latestTrades = Array.isArray(trades) ? [...trades] : [];
        latestTradesLoaded = true;
        
        console.log('Trades recibidos desde Firestore:', trades);
        
        if (!trades || trades.length === 0) {
            console.log('No hay trades registrados');
            latestTrades = [];
            showLoading(false);
            showEmptyState();
            tradesRenderizados = true;
            return;
        }
        
        console.log('Número de trades:', trades.length);
        
        await displayTrades(trades, { initialTab: getActiveTabName() });
        
    } catch (error) {
        showError('Error al cargar los trades: ' + error.message);
        console.error('Error completo:', error);
    } finally {
        showLoading(false);
        showRefreshStatus(false);
    }
}

// Función helper para normalizar datos de trades
function normalizeTradeData(item) {
    // Todos los datos vienen de Firestore en formato objeto
    return {
        id: item.id,
        fecha: item.fecha,
        hora: item.hora,
        ticker: item.ticker,
        tipo: item.tipo,
        cantidad: item.cantidad,
        priceCedear: item.priceCedear,
        total: item.total,
        timestamp: item.timestamp,
        username: item.username,
        source: item.source,
        precioIolArs: item.precioIolArs,
        precioAccionUsd: item.precioAccionUsd,
        ratio: item.ratio,
        tickerUsa: item.tickerUsa,
        precioUsdSourceDate: item.precioUsdSourceDate,
        precioUsdSourceTime: item.precioUsdSourceTime,
        precioUsdSource: item.precioUsdSource,
        importKey: item.importKey,
        _fechaPath: item._fechaPath
    };
}

async function handleExportTradesCsv() {
    if (!currentUser) {
        showError('Debes iniciar sesión para descargar las operaciones');
        return;
    }

    try {
        const trades = latestTradesLoaded ? latestTrades : await ensureLatestTrades();

        if (!trades || trades.length === 0) {
            showWarning('No hay operaciones para exportar');
            return;
        }

        downloadTradesCsv(trades);
        showSuccess('CSV de operaciones descargado');
    } catch (error) {
        console.error('Error al exportar operaciones:', error);
        showError('Error al descargar el CSV: ' + error.message);
    }
}

function downloadTradesCsv(trades) {
    const headers = [
        'fecha',
        'hora',
        'ticker',
        'tipo',
        'cantidad',
        'precio',
        'total',
        'fecha_hora_carga',
        'id'
    ];

    const sortedTrades = [...trades].sort((a, b) => {
        const dateA = a.timestamp ? new Date(a.timestamp) : new Date(a.fecha);
        const dateB = b.timestamp ? new Date(b.timestamp) : new Date(b.fecha);
        return dateA - dateB;
    });

    const rows = sortedTrades.map(item => {
        const trade = normalizeTradeData(item);
        return [
            trade.fecha || '',
            trade.hora || '',
            trade.ticker || '',
            trade.tipo || '',
            formatCsvNumber(trade.cantidad),
            formatCsvNumber(trade.priceCedear),
            formatCsvNumber(trade.total),
            formatCsvDateTime(trade.timestamp),
            trade.id || ''
        ];
    });

    const csv = [
        headers.join(','),
        ...rows.map(row => row.map(escapeCsvValue).join(','))
    ].join('\n');

    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `operaciones-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function escapeCsvValue(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function formatCsvNumber(value) {
    if (value === null || value === undefined || value === '') return '';
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : String(value);
}

function formatCsvDateTime(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
}

// Mostrar trades en el HTML (lista simple)
async function displayTrades(rows, options = {}) {
    console.log('displayTrades llamada con:', rows);
    
    if (rows.length === 0) {
        showEmptyState();
        await updateDashboard([]);
        return;
    }
    
    // Ordenar por fecha (más reciente primero)
    const sortedRows = [...rows].sort((a, b) => {
        // Si es un objeto (Firestore), usar timestamp
        if (a.timestamp && b.timestamp) {
            return new Date(b.timestamp) - new Date(a.timestamp);
        }
        // Si es un array (legacy), usar índice 0
        return new Date(b[0]) - new Date(a[0]);
    });
    
    const initialTab = options.initialTab || getActiveTabName();

    await updateDashboard(rows);

    if (initialTab === 'open-trades') {
        renderOpenTradesList(sortedRows);
    } else if (tradesContainer && !openTradesRendered) {
        tradesContainer.innerHTML = '<div class="loading-placeholder">Abrí "Operaciones" para ver el detalle completo.</div>';
    }

    if (initialTab === 'mis-trades') {
        updateMisTrades(rows);
    } else {
        renderMisTradesPlaceholder();
    }

    tradesRenderizados = true;
    
    console.log('HTML generado, trades renderizados');
}

function renderOpenTradesList(sortedRows) {
    console.log('Renderizando trades en:', tradesContainer);
    
    tradesContainer.innerHTML = sortedRows.map(item => {
        const trade = normalizeTradeData(item);
        const tipoClass = trade.tipo.toLowerCase();
        
        return `
            <div class="trade-card ${tipoClass}">
                <div class="trade-row">
                    <div class="trade-col trade-col-ticker">
                        <div class="trade-symbol">${trade.ticker}</div>
                        <div class="trade-type ${tipoClass}">${trade.tipo}</div>
                    </div>
                    <div class="trade-col trade-col-date">
                        <span class="trade-label">Fecha</span>
                        <span class="trade-value">${formatDate(trade.fecha)}</span>
                    </div>
                    <div class="trade-col trade-col-cantidad">
                        <span class="trade-label">Cantidad</span>
                        <span class="trade-value">${formatCantidad(trade.cantidad)}</span>
                    </div>
                    <div class="trade-col trade-col-precio">
                        <span class="trade-label">Precio</span>
                        <span class="trade-value">$${formatNumber(trade.priceCedear)}</span>
                    </div>
                    <div class="trade-col trade-col-total">
                        <span class="trade-label">Total</span>
                        <span class="trade-value total-value">$${formatNumber(trade.total)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    openTradesRendered = true;
}

function renderMisTradesPlaceholder() {
    const misTradesContent = document.getElementById('misTradesContent');
    if (!misTradesContent || misTradesRendered) return;

    misTradesContent.innerHTML = `
        <p style="text-align: center; color: #999; padding: 60px 20px;">
            Abrí esta pestaña para cargar los trades cerrados.
        </p>
    `;
}

function renderTabContentIfNeeded(tabName) {
    if (!latestTrades.length) return;

    if (tabName === 'open-trades' && !openTradesRendered) {
        const sortedRows = [...latestTrades].sort((a, b) => {
            if (a.timestamp && b.timestamp) {
                return new Date(b.timestamp) - new Date(a.timestamp);
            }
            return new Date(b[0]) - new Date(a[0]);
        });
        renderOpenTradesList(sortedRows);
        return;
    }

    if (tabName === 'mis-trades' && !misTradesRendered) {
        updateMisTrades(latestTrades);
    }
}

// Mostrar estado vacío
function showEmptyState() {
    tradesContainer.innerHTML = `
        <div class="empty-state">
            <h3>No hay trades registrados</h3>
            <p>Comienza agregando tu primer trade usando el formulario arriba</p>
        </div>
    `;
    
    // Limpiar también dashboard y mis trades
    const dashboardContent = document.getElementById('dashboardContent');
    if (dashboardContent) {
        dashboardContent.innerHTML = `
            <div class="empty-state">
                <h3>No hay trades registrados</h3>
                <p>Comienza agregando tu primer trade usando el formulario arriba</p>
            </div>
        `;
    }
    
    const misTradesContent = document.getElementById('misTradesContent');
    if (misTradesContent) {
        misTradesContent.innerHTML = `
            <div class="empty-state">
                <h3>No hay trades registrados</h3>
                <p>Comienza agregando tu primer trade usando el formulario arriba</p>
            </div>
        `;
    }

    openTradesRendered = true;
    misTradesRendered = true;
}

// Traer los precios actuales de los tickers indicados y guardarlos en tickersData.
async function actualizarPreciosTickers(tickersUnicos) {
    if (!tickersUnicos || tickersUnicos.length === 0) return;

    const cedearsConMetadata = tickersUnicos
        .map((ticker) => ticker.toUpperCase())
        .map((ticker) => getCedearMetadata(ticker))
        .filter((metadata) => metadata.ok);

    if (cedearsConMetadata.length === 0) return;

    try {
        const tickersUsa = [...new Set(cedearsConMetadata.map((metadata) => metadata.tickerUsa))];
        const cacheKey = tickersUsa.slice().sort().join(',');
        const cached = stockPricesCache.get(cacheKey);
        let data;

        if (cached && Date.now() < cached.expiresAt) {
            data = cached.data;
        } else {
            const query = encodeURIComponent(tickersUsa.join(','));
            const response = await fetch(`/api/stock-prices?tickers=${query}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            data = await response.json();
            stockPricesCache.set(cacheKey, {
                data,
                expiresAt: Date.now() + STOCK_PRICES_CACHE_MS
            });
        }

        cedearsConMetadata.forEach((metadata) => {
            const tickerInfo = findTickerInfo(metadata.cedearTicker);
            const price = data.prices?.[metadata.tickerUsa]?.price;
            if (tickerInfo && price) {
                tickerInfo.priceCedear = price / metadata.ratio;
            }
        });

        Object.keys(data.errors || {}).forEach((ticker) => {
            console.warn(`No se pudo obtener precio para ${ticker}: ${data.errors[ticker]}`);
        });
    } catch (error) {
        console.warn('No se pudieron obtener precios en lote:', error.message);
    }
}

// Actualizar dashboard: traer precios actuales y luego renderizar con datos completos
async function updateDashboard(rows) {
    const dashboardContent = document.getElementById('dashboardContent');

    if (!dashboardContent) return;

    if (!rows || rows.length === 0) {
        dashboardContent.innerHTML = `
            <div class="empty-state">
                <h3>No hay trades registrados</h3>
                <p>Comienza agregando tu primer trade usando el formulario arriba</p>
            </div>
        `;
        return;
    }

    // Traer precios actuales ANTES de renderizar (evita mostrar ganancias incompletas)
    const tickersUnicos = [...new Set(rows.map(r => normalizeTradeData(r).ticker))];
    await actualizarPreciosTickers(tickersUnicos);

    renderDashboard(rows);
}

// Render sincrónico del dashboard usando los precios actuales en memoria
function renderDashboard(rows) {
    const dashboardContent = document.getElementById('dashboardContent');
    if (!dashboardContent) return;

    // Agrupar trades por ticker y calcular totales
    const tradesByTicker = {};
    let totalInvertido = 0;
    let valorActual = 0;
    let gananciaTotal = 0;
    let gananciaMes = 0;
    let gananciaAnio = 0;
    
    // Obtener fechas de referencia
    const ahora = new Date();
    const anioActual = ahora.getFullYear();
    const mesActual = ahora.getMonth();
    
    rows.forEach(item => {
        const trade = normalizeTradeData(item);
        
        if (!tradesByTicker[trade.ticker]) {
            tradesByTicker[trade.ticker] = [];
        }
        
        tradesByTicker[trade.ticker].push({
            fecha: trade.fecha,
            ticker: trade.ticker,
            tipo: trade.tipo,
            cantidad: parseFloat(trade.cantidad),
            precio: parseFloat(trade.priceCedear),
            total: parseFloat(trade.total),
            timestamp: item.timestamp || trade.fecha
        });
    });
    
    // Calcular ganancia total aplicando FIFO y contar trades activos
    // (los precios actuales ya están en tickersData; se refrescan en segundo plano)
    let numTradesActivos = 0;

    Object.keys(tradesByTicker).forEach(ticker => {
        const trades = tradesByTicker[ticker];
        const tickerInfo = tickersData.find(t => t.ticker === ticker.toUpperCase());
        const precioActual = tickerInfo ? tickerInfo.priceCedear : 0;
        
        // Ordenar por timestamp asc para aplicar LIFO
        trades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const { compras, ventas, ventasPorCompra } = aplicarLifo(trades);
        
        // Calcular ganancias realizadas por ventas (del mes y del año)
        ventas.forEach(venta => {
            const fechaVenta = new Date(venta.timestamp);
            const anioVenta = fechaVenta.getFullYear();
            const mesVenta = fechaVenta.getMonth();
            
            // Buscar las compras asociadas a esta venta
            let gananciaVenta = 0;
            for (let i = compras.length - 1; i >= 0; i--) {
                const ventasDeCompra = ventasPorCompra[i] || [];
                const ventaMatch = ventasDeCompra.find(v => 
                    v.timestamp === venta.timestamp && 
                    v.cantidad === venta.cantidad
                );
                
                if (ventaMatch && ventaMatch.cantidadUsada > 0) {
                    const compra = compras[i];
                    gananciaVenta += (venta.precio - compra.precio) * ventaMatch.cantidadUsada;
                }
            }
            
            // Sumar a ganancia del año si corresponde
            if (anioVenta === anioActual) {
                gananciaAnio += gananciaVenta;
                
                // Sumar a ganancia del mes si corresponde
                if (mesVenta === mesActual) {
                    gananciaMes += gananciaVenta;
                }
            }
        });
        
        // Calcular totales basados en cantidad restante después de LIFO
        compras.forEach(compra => {
            if (compra.cantidadRestante > 0) {
                numTradesActivos++;
                // Total invertido = precio de compra * cantidad restante
                totalInvertido += compra.precio * compra.cantidadRestante;
                
                if (precioActual > 0) {
                    // Valor actual = precio actual * cantidad restante
                    valorActual += precioActual * compra.cantidadRestante;
                    // Ganancia = (precio actual - precio compra) * cantidad restante
                    const ganancia = (precioActual - compra.precio) * compra.cantidadRestante;
                    gananciaTotal += ganancia;
                }
            }
        });
    });
    
    const gananciaPercentTotal = totalInvertido > 0 ? (gananciaTotal / totalInvertido) * 100 : 0;
    const gananciaColor = gananciaTotal >= 0 ? '#22c55e' : '#ef4444';
    const gananciaAnioColor = gananciaAnio >= 0 ? '#22c55e' : '#ef4444';
    const gananciaMesColor = gananciaMes >= 0 ? '#22c55e' : '#ef4444';
    
    // Generar HTML del dashboard
    let html = `
        <div class="dashboard-stats">
            <div class="stat-card stat-primary">
                <div class="stat-label">Ganancia Total</div>
                <div class="stat-value" style="color: white;">
                    ${gananciaTotal >= 0 ? '+' : ''}$${formatNumber(gananciaTotal)}
                </div>
                <div class="stat-percent" style="color: white;">
                    ${gananciaTotal >= 0 ? '+' : ''}${formatNumber(gananciaPercentTotal)}%
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Trades Activos</div>
                <div class="stat-value">${numTradesActivos}</div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Ganancia Neta Año</div>
                <div class="stat-value" style="color: ${gananciaAnioColor};">
                    ${gananciaAnio >= 0 ? '+' : ''}$${formatNumber(gananciaAnio)}
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-label">Ganancia Neta Mes</div>
                <div class="stat-value" style="color: ${gananciaMesColor};">
                    ${gananciaMes >= 0 ? '+' : ''}$${formatNumber(gananciaMes)}
                </div>
            </div>
        </div>
        
        <h3 style="margin: 30px 0 20px 0; color: #2c5282; font-size: 1.3rem;">Trades Abiertos</h3>
        <div class="dashboard-trades">
    `;
    
    // Ordenar tickers alfabéticamente
    const sortedTickers = Object.keys(tradesByTicker).sort();
    
    sortedTickers.forEach(ticker => {
        const trades = tradesByTicker[ticker];
        const tickerInfo = tickersData.find(t => t.ticker === ticker);
        const precioActual = (tickerInfo && tickerInfo.priceCedear) ? tickerInfo.priceCedear : 0;
        
        const tradesOrdenados = [...trades].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const { compras, ventas, ventasPorCompra } = aplicarLifo(tradesOrdenados);
        const comprasActivas = compras.filter(c => c.cantidadRestante > 0);
        
        // Solo mostrar si hay compras activas (posiciones abiertas)
        if (comprasActivas.length === 0) {
            return;
        }
        
        // Calcular ganancia total del ticker
        let gananciaTickerTotal = 0;
        let cantidadTotalAbierta = 0;
        let cantidadTotalOriginal = 0;
        
        comprasActivas.forEach(compra => {
            cantidadTotalOriginal += compra.cantidad;
            cantidadTotalAbierta += compra.cantidadRestante;
            if (precioActual > 0 && compra.cantidadRestante > 0) {
                gananciaTickerTotal += (precioActual - compra.precio) * compra.cantidadRestante;
            }
        });
        
        const porcentajePosicionAbierta = cantidadTotalOriginal > 0 ? (cantidadTotalAbierta / cantidadTotalOriginal) * 100 : 0;
        const gananciaTickerColor = gananciaTickerTotal >= 0 ? '#22c55e' : '#ef4444';
        const totalInvertidoTicker = comprasActivas.reduce((sum, c) => sum + (c.precio * c.cantidadRestante), 0);
        const gananciaTickerPercent = totalInvertidoTicker > 0 ? (gananciaTickerTotal / totalInvertidoTicker) * 100 : 0;
        const tradeId = `ticker-${ticker}-${Date.now()}-${Math.random()}`;
        
        html += `<div class="ticker-group">
            <div class="ticker-group-header" onclick="document.getElementById('${tradeId}').classList.toggle('hidden')" 
                 style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-weight: 600;">${ticker}</span>
                    <span style="color: #666; font-size: 0.8rem; font-weight: 400;">(${Math.round(porcentajePosicionAbierta)}%)</span>
                </div>
                <span style="color: ${gananciaTickerColor}; font-weight: bold; font-size: 0.95rem;">
                    ${gananciaTickerTotal >= 0 ? '+' : ''}$${formatNumber(gananciaTickerTotal)} (${gananciaTickerTotal >= 0 ? '+' : ''}${formatNumber(gananciaTickerPercent)}%)
                </span>
            </div>
            
            <div id="${tradeId}" class="hidden">`;
        
        // Compras activas (cada compra es una sección)
        compras.forEach((compra, index) => {
            if (compra.cantidadRestante === 0) return; // Solo mostrar compras activas
            
            const cantidadRestante = compra.cantidadRestante;
            const cantidadOriginal = compra.cantidad;
            const cantidadVendida = cantidadOriginal - cantidadRestante;
            
            let gananciaActual = 0;
            let gananciaPercentActual = 0;
            if (precioActual > 0 && cantidadRestante > 0) {
                gananciaActual = (precioActual - compra.precio) * cantidadRestante;
                gananciaPercentActual = ((precioActual - compra.precio) / compra.precio) * 100;
            }
            const gananciaColor = gananciaActual >= 0 ? '#22c55e' : '#ef4444';
            const totalRestante = cantidadRestante * compra.precio;
            
            html += `
                <div class="trade-card compra">
                    <div class="trade-row">
                        <div class="trade-col trade-col-date">
                            <span class="trade-label">Fecha Compra</span>
                            <span class="trade-value">${formatDate(compra.fecha)}</span>
                        </div>
                        <div class="trade-col trade-col-cantidad">
                            <span class="trade-label">Cantidad Abierta</span>
                            <span class="trade-value">${formatCantidad(cantidadRestante)} / ${formatCantidad(cantidadOriginal)} (${Math.round((cantidadRestante / cantidadOriginal) * 100)}%)</span>
                        </div>
                        <div class="trade-col trade-col-precio">
                            <span class="trade-label">Precio Compra</span>
                            <span class="trade-value">$${formatNumber(compra.precio)}</span>
                        </div>
                        <div class="trade-col trade-col-precio">
                            <span class="trade-label">Precio Actual</span>
                            <span class="trade-value">$${formatNumber(precioActual)}</span>
                        </div>
                        <div class="trade-col trade-col-total">
                            <span class="trade-label">Total Invertido</span>
                            <span class="trade-value total-value">$${formatNumber(totalRestante)}</span>
                        </div>`;
            
            if (precioActual > 0 && cantidadRestante > 0) {
                html += `
                        <div class="trade-col trade-col-ganancia">
                            <span class="trade-label">Ganancia No Realizada</span>
                            <span class="trade-value" style="color: ${gananciaColor}; font-weight: bold;">
                                ${gananciaActual >= 0 ? '+' : ''}$${formatNumber(gananciaActual)} (${gananciaActual >= 0 ? '+' : ''}${formatNumber(gananciaPercentActual)}%)
                            </span>
                        </div>`;
            }
            
            html += `
                    </div>
                </div>
            `;
            
            // Mostrar ventas parciales de esta compra (si vendió algo)
            const ventasDeEstaCompra = ventasPorCompra[index] || [];
            if (ventasDeEstaCompra.length > 0) {
                ventasDeEstaCompra.forEach(venta => {
                    const gananciaVenta = (venta.precio - compra.precio) * venta.cantidadUsada;
                    const gananciaPercentVenta = ((venta.precio - compra.precio) / compra.precio) * 100;
                    const gananciaColorVenta = gananciaVenta >= 0 ? '#22c55e' : '#ef4444';
                    const totalVendido = venta.precio * venta.cantidadUsada;
                    
                    html += `
                        <div class="trade-card venta">
                            <div class="trade-row">
                                <div class="trade-col trade-col-date">
                                    <span class="trade-label">Fecha Venta</span>
                                    <span class="trade-value">${formatDate(venta.fecha)}</span>
                                </div>
                                <div class="trade-col trade-col-cantidad">
                                    <span class="trade-label">Cantidad Vendida</span>
                                    <span class="trade-value">${formatCantidad(venta.cantidadUsada)}</span>
                                </div>
                                <div class="trade-col trade-col-precio">
                                    <span class="trade-label">Precio Compra</span>
                                    <span class="trade-value">$${formatNumber(compra.precio)}</span>
                                </div>
                                <div class="trade-col trade-col-precio">
                                    <span class="trade-label">Precio Venta</span>
                                    <span class="trade-value">$${formatNumber(venta.precio)}</span>
                                </div>
                                <div class="trade-col trade-col-total">
                                    <span class="trade-label">Total Vendido</span>
                                    <span class="trade-value total-value">$${formatNumber(totalVendido)}</span>
                                </div>
                                <div class="trade-col trade-col-ganancia">
                                    <span class="trade-label">Ganancia Realizada</span>
                                    <span class="trade-value" style="color: ${gananciaColorVenta}; font-weight: bold;">
                                        ${gananciaVenta >= 0 ? '+' : ''}$${formatNumber(gananciaVenta)} (${gananciaVenta >= 0 ? '+' : ''}${formatNumber(gananciaPercentVenta)}%)
                                    </span>
                                </div>
                            </div>
                        </div>
                    `;
                });
            }
        });
        
        html += `</div></div>`;
    });
    
    html += `
        </div>
    `;
    
    dashboardContent.innerHTML = html;
}

// Actualizar "Mis Trades" con trades cerrados completos
function updateMisTrades(rows) {
    const misTradesContent = document.getElementById('misTradesContent');
    
    if (!misTradesContent) return;
    
    if (!rows || rows.length === 0) {
        misTradesContent.innerHTML = `
            <div class="empty-state">
                <h3>No hay trades registrados</h3>
                <p>Comienza agregando tu primer trade usando el formulario arriba</p>
            </div>
        `;
        misTradesRendered = true;
        return;
    }
    
    // Agrupar trades por ticker
    const tradesByTicker = {};
    rows.forEach(item => {
        const trade = normalizeTradeData(item);
        if (!tradesByTicker[trade.ticker]) {
            tradesByTicker[trade.ticker] = [];
        }
        tradesByTicker[trade.ticker].push({
            fecha: trade.fecha,
            ticker: trade.ticker,
            tipo: trade.tipo,
            cantidad: parseFloat(trade.cantidad),
            precio: parseFloat(trade.priceCedear),
            total: parseFloat(trade.total),
            timestamp: item.timestamp || trade.fecha
        });
    });
    
    // Recolectar trades cerrados (lotes con cantidad restante = 0)
    const tradesCerrados = [];
    
    Object.keys(tradesByTicker).forEach(ticker => {
        const trades = tradesByTicker[ticker];
        const tradesOrdenados = [...trades].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const { compras, ventasPorCompra } = aplicarLifo(tradesOrdenados);
        
        compras.forEach((compra, index) => {
            if (compra.cantidadRestante === 0) {
                // Este lote está cerrado completamente
                const cantidadOriginal = compra.cantidad;
                
                // Obtener las ventas que cerraron esta compra
                const ventasDelLote = ventasPorCompra[index] || [];
                
                // Calcular ganancia/pérdida total del lote
                let gananciaTotal = 0;
                ventasDelLote.forEach(venta => {
                    gananciaTotal += (venta.precio - compra.precio) * venta.cantidadUsada;
                });
                const gananciaPercent = ((gananciaTotal) / (compra.precio * cantidadOriginal)) * 100;
                
                // Encontrar el timestamp de venta más reciente para este lote
                const fechaCierre = ventasDelLote.length > 0 
                    ? ventasDelLote.reduce((latest, venta) => {
                        const ventaTime = new Date(venta.timestamp || venta.fecha);
                        const latestTime = new Date(latest);
                        return ventaTime > latestTime ? (venta.timestamp || venta.fecha) : latest;
                    }, ventasDelLote[0].timestamp || ventasDelLote[0].fecha)
                    : compra.fecha;
                
                tradesCerrados.push({
                    ticker,
                    compra,
                    ventas: ventasDelLote,
                    gananciaTotal,
                    gananciaPercent,
                    fechaCierre
                });
            }
        });
    });
    
    if (tradesCerrados.length === 0) {
        misTradesContent.innerHTML = `
            <p style="text-align: center; color: #999; padding: 60px 20px;">
                📊 No hay trades cerrados aún
            </p>
        `;
        misTradesRendered = true;
        return;
    }
    
    // Ordenar por fecha de cierre (más reciente primero)
    tradesCerrados.sort((a, b) => new Date(b.fechaCierre) - new Date(a.fechaCierre));
    
    let html = `
        <div class="dashboard-trades">
    `;
    
    tradesCerrados.forEach(({ ticker, compra, ventas, gananciaTotal, gananciaPercent }) => {
        const gananciaColor = gananciaTotal >= 0 ? '#22c55e' : '#ef4444';
        const cantidadOriginal = compra.cantidad;
        const totalInvertido = compra.precio * cantidadOriginal;
        const tradeId = `trade-${ticker}-${Date.now()}-${Math.random()}`;
        
        html += `
            <div class="ticker-group" style="margin-bottom: 24px;">
                <div class="ticker-group-header" onclick="document.getElementById('${tradeId}').classList.toggle('hidden')" 
                     style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;">
                    <span style="font-weight: 600;">${ticker}</span>
                    <span style="color: ${gananciaColor}; font-weight: bold; font-size: 0.95rem;">
                        ${gananciaTotal >= 0 ? '+' : ''}$${formatNumber(gananciaTotal)} (${gananciaTotal >= 0 ? '+' : ''}${formatNumber(gananciaPercent)}%)
                    </span>
                </div>
                
                <div id="${tradeId}" class="hidden">
                <!-- Compra -->
                <div class="trade-card compra" style="background: #f0f9ff; border-left: 3px solid #3b82f6;">
                    <div class="trade-row">
                        <div class="trade-col trade-col-date">
                            <span class="trade-label">Fecha Compra</span>
                            <span class="trade-value">${formatDate(compra.fecha)}</span>
                        </div>
                        <div class="trade-col trade-col-cantidad">
                            <span class="trade-label">Cantidad</span>
                            <span class="trade-value">${formatCantidad(cantidadOriginal)}</span>
                        </div>
                        <div class="trade-col trade-col-precio">
                            <span class="trade-label">Precio Compra</span>
                            <span class="trade-value">$${formatNumber(compra.precio)}</span>
                        </div>
                        <div class="trade-col trade-col-total">
                            <span class="trade-label">Total Invertido</span>
                            <span class="trade-value total-value">$${formatNumber(totalInvertido)}</span>
                        </div>
                    </div>
                </div>
        `;
        
        // Ventas individuales
        ventas.forEach(venta => {
            const gananciaVenta = (venta.precio - compra.precio) * venta.cantidadUsada;
            const gananciaPercentVenta = ((venta.precio - compra.precio) / compra.precio) * 100;
            const gananciaColorVenta = gananciaVenta >= 0 ? '#22c55e' : '#ef4444';
            const totalVendido = venta.precio * venta.cantidadUsada;
            
            html += `
                <div class="trade-card venta" style="margin-top: 12px; background: #fef2f2; border-left: 3px solid #e11d48;">
                    <div class="trade-row">
                        <div class="trade-col trade-col-date">
                            <span class="trade-label">Fecha Venta</span>
                            <span class="trade-value">${formatDate(venta.fecha)}</span>
                        </div>
                        <div class="trade-col trade-col-cantidad">
                            <span class="trade-label">Cantidad Vendida</span>
                            <span class="trade-value">${formatCantidad(venta.cantidadUsada)}</span>
                        </div>
                        <div class="trade-col trade-col-precio">
                            <span class="trade-label">Precio Venta</span>
                            <span class="trade-value">$${formatNumber(venta.precio)}</span>
                        </div>
                        <div class="trade-col trade-col-total">
                            <span class="trade-label">Total Vendido</span>
                            <span class="trade-value total-value">$${formatNumber(totalVendido)}</span>
                        </div>
                        <div class="trade-col trade-col-ganancia">
                            <span class="trade-label">Ganancia/Pérdida</span>
                            <span class="trade-value" style="color: ${gananciaColorVenta}; font-weight: bold;">
                                ${gananciaVenta >= 0 ? '+' : ''}$${formatNumber(gananciaVenta)} (${gananciaVenta >= 0 ? '+' : ''}${formatNumber(gananciaPercentVenta)}%)
                            </span>
                        </div>
                    </div>
                </div>
            `;
        });
        
        // Resultado total del trade
        html += `
                <div class="trade-card" style="margin-top: 16px; background: ${gananciaTotal >= 0 ? '#f0fdf4' : '#fef2f2'}; border-left: 4px solid ${gananciaColor}; padding: 16px;">
                    <div style="display: flex; flex-direction: column; gap: 6px; text-align: center;">
                        <span style="font-size: 0.85rem; color: #666; font-weight: 500;">Resultado Total del Trade</span>
                        <span style="color: ${gananciaColor}; font-weight: bold; font-size: 1.1rem;">
                            ${gananciaTotal >= 0 ? '+' : ''}$${formatNumber(gananciaTotal)} (${gananciaTotal >= 0 ? '+' : ''}${formatNumber(gananciaPercent)}%)
                        </span>
                    </div>
                </div>
                </div>
            </div>
        `;
    });
    
    html += `
        </div>
    `;
    
    misTradesContent.innerHTML = html;
    misTradesRendered = true;
}

// Funciones de UI
function showLoading(show) {
    loadingEl.classList.toggle('show', show);
}

function showRefreshStatus(show, message = 'Actualizando...') {
    if (!refreshStatusEl) {
        refreshStatusEl = document.createElement('div');
        refreshStatusEl.className = 'refresh-status';
        refreshStatusEl.setAttribute('role', 'status');
        refreshStatusEl.setAttribute('aria-live', 'polite');
        document.body.appendChild(refreshStatusEl);
    }

    refreshStatusEl.textContent = message;
    refreshStatusEl.classList.toggle('show', show);
}

function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add('show');
}

function hideError() {
    errorEl.classList.remove('show');
}

function showSuccess(message) {
    // Crear y mostrar mensaje de éxito temporal
    const successEl = document.createElement('div');
    successEl.className = 'success';
    successEl.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #22c55e;
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        box-shadow: 0 5px 20px rgba(0,0,0,0.2);
        z-index: 1000;
    `;
    successEl.textContent = message;
    document.body.appendChild(successEl);
    
    setTimeout(() => {
        successEl.remove();
    }, 3000);
}

function showWarning(message) {
    // Crear y mostrar mensaje de advertencia temporal
    const warningEl = document.createElement('div');
    warningEl.className = 'warning';
    warningEl.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ef4444;
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        box-shadow: 0 5px 20px rgba(0,0,0,0.2);
        z-index: 1000;
        font-weight: 500;
    `;
    warningEl.textContent = message;
    document.body.appendChild(warningEl);
    
    setTimeout(() => {
        warningEl.remove();
    }, 4000);
}

// Funciones de formato
function formatDate(dateString) {
    if (!dateString) return '';
    
    // Limpiar espacios
    const cleanDate = String(dateString).trim();
    
    // Si viene en formato YYYY-MM-DD, parsearlo como fecha local
    if (cleanDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = cleanDate.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        return date.toLocaleDateString('es-ES', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }
    
    // Para otros formatos (con hora ISO)
    const date = new Date(cleanDate);
    return date.toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function formatNumber(num) {
    return parseFloat(num).toLocaleString('es-ES', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatCantidad(num) {
    return parseFloat(num).toLocaleString('es-ES', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    });
}
