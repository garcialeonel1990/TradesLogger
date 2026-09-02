import { saveBullrun, saveVenta, getResumenCripto, getPreciosActuales, getBullrunByCripto, getVentasByCripto, getCryptoPortfolioData, CRIPTOS } from './managers/bullrun-manager.js';

const cryptoForm = document.getElementById('cryptoForm');
const cryptoStatus = document.getElementById('cryptoStatus');
const cryptoFecha = document.getElementById('cryptoFecha');

// Establecer la fecha actual por defecto
function setFechaHoy() {
    const hoy = new Date();
    const year = hoy.getFullYear();
    const month = String(hoy.getMonth() + 1).padStart(2, '0');
    const day = String(hoy.getDate()).padStart(2, '0');
    cryptoFecha.value = `${year}-${month}-${day}`;
}
setFechaHoy();

function showCryptoStatus(message, type) {
    const colors = { success: '#2e7d32', error: '#c62828', info: '#666' };
    cryptoStatus.textContent = message;
    cryptoStatus.style.color = colors[type] || colors.info;
}

// ===== Selector Compra / Venta =====
const cryptoTipoInput = document.getElementById('cryptoTipo');
const cryptoTipoButtons = document.getElementById('cryptoTipoButtons');
const cryptoMonedaSelect = document.getElementById('cryptoMoneda');
const cryptoTenenciaEl = document.getElementById('cryptoTenencia');
const cryptoSubmitBtn = document.getElementById('cryptoSubmitBtn');
const cryptoPrecioLabel = document.getElementById('cryptoPrecioLabel');
const cryptoCantidadLabel = document.getElementById('cryptoCantidadLabel');

function aplicarTipoUI() {
    const tipo = cryptoTipoInput.value;
    cryptoTipoButtons.querySelectorAll('.btn-tipo').forEach((b) => {
        b.classList.toggle('active', b.dataset.tipo === tipo);
    });
    if (tipo === 'Venta') {
        cryptoSubmitBtn.textContent = 'Cargar Venta';
        cryptoPrecioLabel.textContent = 'Precio de venta (USD):';
        cryptoCantidadLabel.textContent = 'Cantidad vendida:';
    } else {
        cryptoSubmitBtn.textContent = 'Cargar Compra';
        cryptoPrecioLabel.textContent = 'Precio de compra (USD):';
        cryptoCantidadLabel.textContent = 'Cantidad obtenida:';
    }
    actualizarTenencia();
}

cryptoTipoButtons.querySelectorAll('.btn-tipo').forEach((btn) => {
    btn.addEventListener('click', () => {
        cryptoTipoInput.value = btn.dataset.tipo;
        aplicarTipoUI();
    });
});

// Mostrar tenencia disponible cuando es Venta y hay cripto elegida
async function actualizarTenencia() {
    const tipo = cryptoTipoInput.value;
    const cripto = cryptoMonedaSelect.value;
    if (tipo !== 'Venta' || !cripto || !window.firebaseAuth?.currentUser) {
        cryptoTenenciaEl.style.display = 'none';
        return;
    }
    cryptoTenenciaEl.style.display = 'block';
    cryptoTenenciaEl.textContent = 'Calculando tenencia...';
    try {
        const { tenencia } = await getResumenCripto(cripto);
        cryptoTenenciaEl.textContent = `Disponible para vender: ${tenencia} ${cripto}`;
    } catch (error) {
        cryptoTenenciaEl.textContent = '';
        cryptoTenenciaEl.style.display = 'none';
    }
}
cryptoMonedaSelect.addEventListener('change', actualizarTenencia);

cryptoForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!window.firebaseAuth?.currentUser) {
        showCryptoStatus('⚠️ Debes iniciar sesión para cargar criptos', 'error');
        return;
    }

    const tipo = cryptoTipoInput.value;
    const cripto = cryptoMonedaSelect.value;
    const fecha = cryptoFecha.value;
    const precio = parseFloat(document.getElementById('cryptoPrecio').value);
    const cantidad = parseFloat(document.getElementById('cryptoCantidad').value);

    if (!cripto || !fecha || !(precio > 0) || !(cantidad > 0)) {
        showCryptoStatus('⚠️ Completá todos los campos con valores válidos', 'error');
        return;
    }

    const submitBtn = cryptoSubmitBtn;
    const textoOriginal = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando...';
    showCryptoStatus('Guardando...', 'info');
    let operacionGuardada = false;

    try {
        if (tipo === 'Venta') {
            const { ganancia, gananciaPct } = await saveVenta({ cripto, fecha, precio, cantidad });
            const signo = ganancia >= 0 ? '+' : '';
            const tipoMsg = ganancia >= 0 ? 'Ganancia' : 'Pérdida';
            showCryptoStatus(
                `✅ Venta de ${cantidad} ${cripto} · ${tipoMsg}: ${signo}${fmtUSD(ganancia)} (${signo}${gananciaPct.toFixed(2)}%)`,
                ganancia >= 0 ? 'success' : 'error'
            );
        } else {
            await saveBullrun({ cripto, fecha, precio, cantidad });
            showCryptoStatus(`✅ ${cantidad} ${cripto} cargada/s correctamente`, 'success');
        }
        cryptoForm.reset();
        cryptoTipoInput.value = 'Compra';
        aplicarTipoUI();
        setFechaHoy();
        operacionGuardada = true;
    } catch (error) {
        console.error('❌ Error al guardar operación:', error);
        showCryptoStatus('Error al guardar: ' + error.message, 'error');
    } finally {
        submitBtn.disabled = false;
        if (cryptoTipoInput.value === tipo) {
            submitBtn.textContent = textoOriginal;
        } else {
            aplicarTipoUI();
        }
    }

    // Refrescar indicadores tras una operación exitosa
    if (operacionGuardada) {
        setOperationPanel(false);
        renderIndicadores();
        // Refrescar los paneles que estén abiertos
        if (ventasPanel && ventasPanel.style.display !== 'none') renderVentas();
    }
});

// ===== Sección 1: Indicadores de rendimiento =====
const indicadoresEl = document.getElementById('cryptoIndicadores');
const cryptoRefreshBtn = document.getElementById('cryptoRefreshBtn');
const cryptoLastUpdate = document.getElementById('cryptoLastUpdate');
let cryptoPrivacyBtn = null;
const cryptoNewOperationBtn = document.getElementById('cryptoNewOperationBtn');
const cryptoOperationPanel = document.getElementById('cryptoOperationPanel');
const cryptoOperationCloseBtn = document.getElementById('cryptoOperationCloseBtn');

let cryptoValoresOcultos = false;
let renderizandoIndicadores = false;
let cryptoDashboardSnapshot = null;
let cryptoDetalleAbierto = null;

const cryptoMeta = {
    BTC: { nombre: 'Bitcoin', icono: 'B', color: '#f59e0b' },
    HYPE: { nombre: 'Hyperliquid', icono: 'H', color: '#0ea5e9' },
    SOL: { nombre: 'Solana', icono: 'S', color: '#10b981' }
};

function fmtUSD(n, options = {}) {
    if (cryptoValoresOcultos) return 'US$ ••••';
    if (n == null || Number.isNaN(Number(n))) return '--';
    return Number(n).toLocaleString('es-AR', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: options.minimumFractionDigits ?? 2,
        maximumFractionDigits: options.maximumFractionDigits ?? 2
    });
}

function fmtPrecio(n) {
    if (n == null || Number.isNaN(Number(n))) return '--';
    const abs = Math.abs(Number(n));
    const dec = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
    return fmtUSD(n, { maximumFractionDigits: dec });
}

function fmtSignedUSD(n) {
    if (cryptoValoresOcultos) return 'US$ ••••';
    if (n == null || Number.isNaN(Number(n))) return '--';
    const signo = n > 0 ? '+' : n < 0 ? '-' : '';
    return `${signo}${fmtUSD(Math.abs(n))}`;
}

function fmtPct(n) {
    if (cryptoValoresOcultos) return '••••';
    if (n == null || Number.isNaN(Number(n))) return '--';
    const signo = n > 0 ? '+' : '';
    return `${signo}${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function fmtNumCorto(n, dec = 8) {
    if (n == null || Number.isNaN(Number(n))) return '--';
    return Number(n).toLocaleString('es-AR', { maximumFractionDigits: dec });
}

function claseResultado(n) {
    if (n == null || Math.abs(n) < 0.005) return 'is-neutral';
    return n > 0 ? 'is-positive' : 'is-negative';
}

function formatCryptoUpdate(date) {
    if (!(date instanceof Date) || isNaN(date)) return 'Precios pendientes de actualización';
    const hoy = new Date();
    const mismaFecha = date.toDateString() === hoy.toDateString();
    const hora = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    if (mismaFecha) return `Actualizado hoy, ${hora}`;
    const fecha = date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `Actualizado el ${fecha}, ${hora}`;
}

function fmtFechaOperacion(value) {
    if (!value) return '--';
    if (typeof value === 'string') {
        const [year, month, day] = value.split('-').map(Number);
        if (year && month && day) {
            return new Date(year, month - 1, day).toLocaleDateString('es-AR');
        }
        return value;
    }
    return fmtFecha(value);
}

function setOperationPanel(open) {
    if (!cryptoOperationPanel || !cryptoNewOperationBtn) return;
    document.getElementById('crypto')?.classList.toggle('is-operation-mode', open);
    cryptoOperationPanel.style.display = open ? 'block' : 'none';
    cryptoOperationPanel.setAttribute('aria-hidden', String(!open));
    cryptoNewOperationBtn.setAttribute('aria-expanded', String(open));
    cryptoNewOperationBtn.textContent = open ? 'Volver al portafolio' : '+ Nueva operación';
    if (open) {
        requestAnimationFrame(() => {
            cryptoOperationPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            cryptoMonedaSelect?.focus({ preventScroll: true });
        });
    }
}

function setAccordionOpen(button, panel, open) {
    if (!button || !panel) return;
    panel.style.display = open ? 'block' : 'none';
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('is-open', open);
}

function setAccordionCount(id, count) {
    const el = document.getElementById(id);
    if (el) el.textContent = Number.isFinite(count) ? `(${count})` : '';
}

function buildCryptoSnapshot(precios, resumenes, comprasPorCripto, ventasPorCripto) {
    const activos = CRIPTOS.map((cripto, index) => {
        const resumen = resumenes[index];
        const actual = precios[cripto];
        const tenencia = Math.max(0, resumen.tenencia || 0);
        const precioPromedio = resumen.precioPromedio || 0;
        const capitalInvertido = tenencia > 0 ? tenencia * precioPromedio : 0;
        const valorActual = tenencia > 0 && actual != null ? tenencia * actual : 0;
        const gananciaNoRealizada = tenencia > 0 && actual != null ? valorActual - capitalInvertido : null;
        const gananciaNoRealizadaPct = capitalInvertido > 0 && gananciaNoRealizada != null
            ? (gananciaNoRealizada / capitalInvertido) * 100
            : null;

        return {
            cripto,
            meta: cryptoMeta[cripto] || { nombre: cripto, icono: cripto[0], color: '#64748b' },
            resumen,
            compras: comprasPorCripto[index],
            ventas: ventasPorCripto[index],
            precioActual: actual,
            tenencia,
            capitalInvertido,
            valorActual,
            gananciaNoRealizada,
            gananciaNoRealizadaPct,
            gananciaRealizada: resumen.gananciaRealizada || 0,
            tieneActividad: (resumen.cargas || 0) > 0 || (resumen.ventas || 0) > 0 || tenencia > 1e-12
        };
    });

    const totalValorActual = activos.reduce((sum, a) => sum + a.valorActual, 0);
    const totalCapitalInvertido = activos.reduce((sum, a) => sum + a.capitalInvertido, 0);
    const totalGananciaNoRealizada = activos.reduce((sum, a) => sum + (a.gananciaNoRealizada ?? 0), 0);
    const totalGananciaRealizada = activos.reduce((sum, a) => sum + a.gananciaRealizada, 0);
    const totalResultado = totalGananciaNoRealizada + totalGananciaRealizada;
    const totalCompras = activos.reduce((sum, a) => sum + a.compras.length, 0);
    const totalVentas = activos.reduce((sum, a) => sum + a.ventas.length, 0);

    return {
        activos,
        totalValorActual,
        totalCapitalInvertido,
        totalGananciaNoRealizada,
        totalGananciaNoRealizadaPct: totalCapitalInvertido > 0 ? (totalGananciaNoRealizada / totalCapitalInvertido) * 100 : null,
        totalGananciaRealizada,
        totalResultado,
        totalCompras,
        totalVentas,
        actualizado: new Date()
    };
}

function summaryCardHTML(label, value, valueClass = 'is-neutral') {
    return `
        <article class="crypto-summary-card">
            <span>${label}</span>
            <strong class="${valueClass}">${value}</strong>
        </article>`;
}

function privacyIconHTML(hidden) {
    if (hidden) {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 3l18 18"></path>
                <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path>
                <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c5.2 0 8.6 4.5 9.7 6.2a3.3 3.3 0 0 1 0 3.6 17.6 17.6 0 0 1-2.1 2.6"></path>
                <path d="M6.4 6.4a17.2 17.2 0 0 0-4.1 3.8 3.3 3.3 0 0 0 0 3.6C3.4 15.5 6.8 20 12 20c1.5 0 2.9-.4 4.1-1"></path>
            </svg>`;
    }

    return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2.3 10.2a3.3 3.3 0 0 0 0 3.6C3.4 15.5 6.8 20 12 20s8.6-4.5 9.7-6.2a3.3 3.3 0 0 0 0-3.6C20.6 8.5 17.2 4 12 4s-8.6 4.5-9.7 6.2Z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        </svg>`;
}

function heroResultHTML(amount, percent) {
    return `
        <span>${amount}</span>
        <span class="crypto-hero-result-separator" aria-hidden="true"></span>
        <span>${percent}</span>`;
}

function distributionHTML(snapshot) {
    const activosConTenencia = snapshot.activos
        .filter((a) => a.tenencia > 1e-12 && a.valorActual > 0)
        .sort((a, b) => b.valorActual - a.valorActual);

    if (!activosConTenencia.length || snapshot.totalValorActual <= 0) {
        return `
            <section class="crypto-card crypto-distribution-section">
                <div class="crypto-section-title">
                    <h3>Distribución</h3>
                </div>
                <p class="crypto-empty-state">Sin tenencias abiertas para distribuir.</p>
            </section>`;
    }

    const segments = activosConTenencia.map((a) => {
        const pct = (a.valorActual / snapshot.totalValorActual) * 100;
        return `<span style="width:${pct}%; background:${a.meta.color};" title="${a.cripto} ${fmtPct(pct)}"></span>`;
    }).join('');

    const leyenda = activosConTenencia.map((a) => {
        const pct = (a.valorActual / snapshot.totalValorActual) * 100;
        return `
            <div class="crypto-distribution-item">
                <span class="crypto-dot" style="background:${a.meta.color};"></span>
                <strong>${a.cripto}</strong>
                <span>${fmtPct(pct)}</span>
            </div>`;
    }).join('');

    return `
        <section class="crypto-card crypto-distribution-section">
            <div class="crypto-section-title">
                <h3>Distribución</h3>
            </div>
            <div class="crypto-distribution-bar" aria-label="Distribución del portafolio">${segments}</div>
            <div class="crypto-distribution-list">${leyenda}</div>
        </section>`;
}

function assetRowHTML(asset) {
    const detalleAbierto = cryptoDetalleAbierto === asset.cripto;
    const detalleId = `cryptoDetail-${asset.cripto}`;
    const unrealizedText = asset.gananciaNoRealizada == null
        ? '--'
        : `${fmtSignedUSD(asset.gananciaNoRealizada)} (${fmtPct(asset.gananciaNoRealizadaPct)})`;

    return `
        <div class="crypto-asset-block">
            <div class="crypto-assets-grid crypto-asset-row">
                <div class="crypto-asset-main" data-label="Activo">
                    <span class="crypto-asset-icon" style="background:${asset.meta.color};">${asset.meta.icono}</span>
                    <div>
                        <strong>${asset.meta.nombre}</strong>
                        <span>${asset.cripto}</span>
                    </div>
                </div>
                <div data-label="Tenencia">${fmtNumCorto(asset.tenencia)} ${asset.cripto}</div>
                <div data-label="Valor actual">
                    <strong>${fmtUSD(asset.valorActual)}</strong>
                    <span class="${claseResultado(asset.gananciaNoRealizada)}">${unrealizedText}</span>
                </div>
                <div data-label="Precio promedio">${asset.resumen.precioPromedio > 0 ? fmtPrecio(asset.resumen.precioPromedio) : '--'}</div>
                <div data-label="Precio actual">${fmtPrecio(asset.precioActual)}</div>
                <div data-label="Realizada" class="${claseResultado(asset.gananciaRealizada)}">${fmtSignedUSD(asset.gananciaRealizada)}</div>
                <div data-label="Acción">
                    <button type="button" class="crypto-detail-btn" data-crypto-detail="${asset.cripto}" aria-expanded="${detalleAbierto}" aria-controls="${detalleId}">
                        ${detalleAbierto ? 'Ocultar' : 'Ver detalle'}
                    </button>
                </div>
            </div>
            <div id="${detalleId}" class="crypto-asset-detail" ${detalleAbierto ? '' : 'hidden'}>
                ${detalleAbierto ? assetDetailHTML(asset) : ''}
            </div>
        </div>`;
}

function assetsHTML(snapshot) {
    const activos = snapshot.activos.filter((a) => a.tieneActividad);

    if (!activos.length) {
        return `
            <section class="crypto-card crypto-assets-section">
                <div class="crypto-section-title">
                    <h3>Activos</h3>
                </div>
                <p class="crypto-empty-state">Todavía no hay operaciones de crypto registradas.</p>
            </section>`;
    }

    return `
        <section class="crypto-card crypto-assets-section">
            <div class="crypto-section-title">
                <h3>Activos</h3>
            </div>
            <div class="crypto-assets-table">
                <div class="crypto-assets-grid crypto-assets-head">
                    <span>Activo</span>
                    <span>Tenencia</span>
                    <span>Valor actual</span>
                    <span>Precio promedio</span>
                    <span>Precio actual</span>
                    <span>Realizada</span>
                    <span>Acción</span>
                </div>
                ${activos.map(assetRowHTML).join('')}
            </div>
        </section>`;
}

function renderCryptoDashboard(snapshot) {
    document.getElementById('crypto').classList.toggle('is-private', cryptoValoresOcultos);
    if (!snapshot) return;

    if (cryptoLastUpdate) cryptoLastUpdate.textContent = formatCryptoUpdate(snapshot.actualizado);
    setAccordionCount('cryptoVentasCount', snapshot.totalVentas);

    indicadoresEl.innerHTML = `
        <section class="crypto-hero-card">
            <span>Valor actual del portafolio</span>
            <div class="crypto-hero-value-row">
                <strong>${fmtUSD(snapshot.totalValorActual)}</strong>
                <button type="button" id="cryptoPrivacyBtn" class="crypto-privacy-icon-btn" aria-pressed="${cryptoValoresOcultos}" aria-label="${cryptoValoresOcultos ? 'Mostrar importes' : 'Ocultar importes'}" title="${cryptoValoresOcultos ? 'Mostrar importes' : 'Ocultar importes'}">
                    ${privacyIconHTML(cryptoValoresOcultos)}
                </button>
            </div>
            <div class="crypto-hero-result ${claseResultado(snapshot.totalGananciaNoRealizada)}">
                ${heroResultHTML(fmtSignedUSD(snapshot.totalGananciaNoRealizada), fmtPct(snapshot.totalGananciaNoRealizadaPct))}
            </div>
        </section>
        <div class="crypto-summary-grid">
            ${summaryCardHTML('Capital invertido', fmtUSD(snapshot.totalCapitalInvertido))}
            ${summaryCardHTML('Ganancia realizada', fmtSignedUSD(snapshot.totalGananciaRealizada), claseResultado(snapshot.totalGananciaRealizada))}
            ${summaryCardHTML('Resultado acumulado', fmtSignedUSD(snapshot.totalResultado), claseResultado(snapshot.totalResultado))}
        </div>
        ${distributionHTML(snapshot)}
        ${assetsHTML(snapshot)}`;

    cryptoPrivacyBtn = document.getElementById('cryptoPrivacyBtn');
    cryptoPrivacyBtn?.addEventListener('click', toggleCryptoPrivacy);

    indicadoresEl.querySelectorAll('[data-crypto-detail]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const cripto = btn.dataset.cryptoDetail;
            cryptoDetalleAbierto = cryptoDetalleAbierto === cripto ? null : cripto;
            renderCryptoDashboard(cryptoDashboardSnapshot);
        });
    });
}

async function renderIndicadores(forcePrices = false) {
    if (renderizandoIndicadores) return;
    renderizandoIndicadores = true;

    if (!window.firebaseAuth?.currentUser) {
        indicadoresEl.innerHTML = '<p class="crypto-empty-state">Iniciá sesión para ver el rendimiento.</p>';
        renderizandoIndicadores = false;
        return;
    }

    if (cryptoLastUpdate) cryptoLastUpdate.textContent = 'Actualizando precios...';

    try {
        const [precios, portfolioData] = await Promise.all([
            getPreciosActuales({ force: forcePrices }),
            getCryptoPortfolioData()
        ]);

        cryptoDashboardSnapshot = buildCryptoSnapshot(
            precios,
            portfolioData.resumenes,
            portfolioData.comprasPorCripto,
            portfolioData.ventasPorCripto
        );
        renderCryptoDashboard(cryptoDashboardSnapshot);
    } catch (error) {
        console.error('❌ Error cargando indicadores:', error);
        indicadoresEl.innerHTML = '<p class="crypto-empty-state crypto-error-text">Error al cargar indicadores.</p>';
        if (cryptoLastUpdate) cryptoLastUpdate.textContent = 'No se pudieron actualizar los precios';
    } finally {
        renderizandoIndicadores = false;
    }
}

if (cryptoNewOperationBtn) {
    cryptoNewOperationBtn.addEventListener('click', () => {
        const isOpen = cryptoOperationPanel?.style.display !== 'none';
        setOperationPanel(!isOpen);
    });
}

if (cryptoOperationCloseBtn) {
    cryptoOperationCloseBtn.addEventListener('click', () => setOperationPanel(false));
}

function toggleCryptoPrivacy() {
    cryptoValoresOcultos = !cryptoValoresOcultos;
    renderCryptoDashboard(cryptoDashboardSnapshot);
    if (ventasPanel && ventasPanel.style.display !== 'none') renderVentas();
}

export async function openCryptoDashboard() {
    return renderIndicadores();
}

window.openCryptoDashboard = openCryptoDashboard;

// Botón de refrescar precios
if (cryptoRefreshBtn) {
    cryptoRefreshBtn.addEventListener('click', () => renderIndicadores(true));
}

// ===== Trades cerrados (ventas) =====
const toggleVentasBtn = document.getElementById('toggleCryptoVentas');
const ventasPanel = document.getElementById('cryptoVentasPanel');

function fmtFecha(d) {
    if (!(d instanceof Date) || isNaN(d)) return '--';
    return d.toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function fmtNum(n, dec = 8) {
    if (n == null) return '--';
    return Number(n).toLocaleString('es-AR', { maximumFractionDigits: dec });
}

function tablaComprasHTML(cripto, compras) {
    if (!compras.length) {
        return '<p style="color: #999; padding: 8px 0;">Sin compras registradas.</p>';
    }
    const filas = compras.map((c) => {
        return `
            <tr>
                <td data-label="Fecha">${fmtFechaOperacion(c.fecha)}</td>
                <td data-label="Precio (USD)" style="text-align:right;">${fmtUSD(c.precio)}</td>
                <td data-label="Cantidad" style="text-align:right;">${fmtNum(c.cantidad)}</td>
                <td data-label="Invertido (USD)" style="text-align:right;">${fmtUSD(c.precio * c.cantidad)}</td>
            </tr>`;
    }).join('');
    return `
        <h4 style="margin: 8px 0;">🟢 Compras</h4>
        <div style="overflow-x: auto;">
            <table class="tickers-table" style="width: 100%;">
                <thead>
                    <tr>
                        <th>Fecha</th>
                        <th style="text-align:right;">Precio (USD)</th>
                        <th style="text-align:right;">Cantidad</th>
                        <th style="text-align:right;">Invertido (USD)</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        </div>`;
}

function tablaVentasHTML(cripto, ventas) {
    if (!ventas.length) {
        return '<p style="color: #999; padding: 8px 0;">Sin ventas registradas.</p>';
    }
    const filas = ventas.map((v) => {
        const g = v.ganancia || 0;
        const color = g >= 0 ? '#047857' : '#b91c1c';
        return `
            <tr>
                <td data-label="Fecha">${fmtFechaOperacion(v.fecha)}</td>
                <td data-label="Precio prom." style="text-align:right;">${fmtUSD(v.costoBase)}</td>
                <td data-label="Precio venta" style="text-align:right;">${fmtUSD(v.precio)}</td>
                <td data-label="Cantidad" style="text-align:right;">${fmtNum(v.cantidad)}</td>
                <td data-label="Total vendido" style="text-align:right;">${fmtUSD(v.precio * v.cantidad)}</td>
                <td data-label="Ganancia" style="text-align:right; color:${color}; font-weight:bold;">${fmtSignedUSD(g)} (${fmtPct(v.gananciaPct ?? 0)})</td>
            </tr>`;
    }).join('');
    return `
        <h4 style="margin: 16px 0 8px;">🔴 Ventas</h4>
        <div style="overflow-x: auto;">
            <table class="tickers-table" style="width: 100%;">
                <thead>
                    <tr>
                        <th>Fecha</th>
                        <th style="text-align:right;">Precio prom.</th>
                        <th style="text-align:right;">Precio venta</th>
                        <th style="text-align:right;">Cantidad</th>
                        <th style="text-align:right;">Total vendido</th>
                        <th style="text-align:right;">Ganancia</th>
                    </tr>
                </thead>
                <tbody>${filas}</tbody>
            </table>
        </div>`;
}

function bloqueCriptoHTML(cripto, contenido) {
    return `
        <div class="crypto-history-block">
            <h3>${cripto}</h3>
            ${contenido}
        </div>`;
}

function assetDetailHTML(asset) {
    return `
        <div class="crypto-detail-grid">
            <div>${tablaComprasHTML(asset.cripto, asset.compras)}</div>
            <div>${tablaVentasHTML(asset.cripto, asset.ventas)}</div>
        </div>`;
}

let renderizandoVentas = false;
async function renderVentas() {
    if (renderizandoVentas) return;
    renderizandoVentas = true;

    if (!window.firebaseAuth?.currentUser) {
        ventasPanel.innerHTML = '<p style="text-align:center;color:#999;padding:20px;">Iniciá sesión para ver los trades cerrados</p>';
        renderizandoVentas = false;
        return;
    }

    try {
        const ventas = await Promise.all(CRIPTOS.map((c) => getVentasByCripto(c)));
        setAccordionCount('cryptoVentasCount', ventas.reduce((sum, items) => sum + items.length, 0));
        ventasPanel.innerHTML = CRIPTOS
            .map((c, i) => bloqueCriptoHTML(c, tablaVentasHTML(c, ventas[i])))
            .join('');
    } catch (error) {
        console.error('❌ Error cargando trades cerrados:', error);
        ventasPanel.innerHTML = '<p style="text-align:center;color:#c62828;padding:20px;">Error al cargar los trades cerrados</p>';
    } finally {
        renderizandoVentas = false;
    }
}

if (toggleVentasBtn && ventasPanel) {
    toggleVentasBtn.addEventListener('click', () => {
        if (ventasPanel.style.display === 'none') {
            setAccordionOpen(toggleVentasBtn, ventasPanel, true);
            renderVentas();
        } else {
            setAccordionOpen(toggleVentasBtn, ventasPanel, false);
        }
    });
}
