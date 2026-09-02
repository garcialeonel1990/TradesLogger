// Cargar dashboard de cauciones cuando se active el tab
import { getFirestore, collection, query, orderBy, getDocs, limit } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

let caucionesCargadas = false;

async function cargarDashboardCauciones(force = false) {
    if (force) {
        caucionesCargadas = false; // Resetear para forzar recarga
    }
    if (caucionesCargadas && !force) return;
    
    console.log('🔄 Cargando dashboard de cauciones...');
    
    try {
        const db = getFirestore(window.firebaseApp);
        
        // Cargar tasas en tiempo real
        await cargarTasasActuales(db);
        
        // Cargar estadísticas históricas
        const q = query(collection(db, 'max_dia'), orderBy('fecha', 'desc'));
        const querySnapshot = await getDocs(q);
        
        console.log('📊 Documentos encontrados en max_dia:', querySnapshot.size);
        
        // Unificar T1 y T3 por fecha, tomando el máximo de cada día
        const maximosPorFecha = new Map();
        
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            console.log('📄 Documento:', doc.id, data);
            
            const fecha = data.fecha;
            const actual = { id: doc.id, ...data };
            
            if (!maximosPorFecha.has(fecha)) {
                maximosPorFecha.set(fecha, actual);
            } else {
                // Si ya existe esta fecha, comparar y quedarse con el de mayor tasa
                const existente = maximosPorFecha.get(fecha);
                if (actual.tasa_max > existente.tasa_max) {
                    console.log(`  📊 Fecha ${fecha}: ${actual.tipo} (${actual.tasa_max}%) > ${existente.tipo} (${existente.tasa_max}%), usando ${actual.tipo}`);
                    maximosPorFecha.set(fecha, actual);
                } else {
                    console.log(`  📊 Fecha ${fecha}: Manteniendo ${existente.tipo} (${existente.tasa_max}%) >= ${actual.tipo} (${actual.tasa_max}%)`);
                }
            }
        });
        
        // Convertir el Map a array y ordenar por fecha descendente
        const maximos = Array.from(maximosPorFecha.values())
            .sort((a, b) => b.fecha.localeCompare(a.fecha));
        
        console.log('📈 Datos unificados (T1+T3):', maximos.length, 'días únicos');
        
        if (maximos.length === 0) {
            console.warn('⚠️ No se encontraron datos históricos');
            mostrarSinDatosHistoricos();
        } else {
            console.log('✅ Procesando', maximos.length, 'registros históricos');
            
            // Verificar que los elementos existan
            const hourChart = document.getElementById('hourChart');
            const historyTable = document.getElementById('historyTable');
            console.log('🔍 Elementos DOM:', { hourChart: !!hourChart, historyTable: !!historyTable });
            
            calcularEstadisticasCauciones(maximos);
            crearGraficoHorasCauciones(maximos);
            crearTablaHistorialCauciones(maximos);
            
            console.log('🎉 Dashboard de cauciones cargado completamente');
        }
        
        caucionesCargadas = true;
    } catch (error) {
        console.error('❌ Error cargando dashboard cauciones:', error);
        console.error('Detalle del error:', error.message, error.stack);
        mostrarSinDatosHistoricos();
        
        // Mostrar error en pantalla
        const historyTable = document.getElementById('historyTable');
        historyTable.innerHTML = `<div style="text-align: center; padding: 40px; color: #dc3545;"><strong>⚠️ Error al cargar datos</strong><br><br>${error.message}</div>`;
        historyTable.classList.remove('loading');
        
        const hourChart = document.getElementById('hourChart');
        hourChart.innerHTML = `<div style="text-align: center; padding: 40px; color: #dc3545;">Error: ${error.message}</div>`;
        hourChart.classList.remove('loading');
        
        caucionesCargadas = true;
    }
}

async function cargarTasasActuales(db) {
    try {
        console.log('📡 Cargando tasas actuales...');
        
        // Obtener día de la semana (0=Dom, 1=Lun, ..., 5=Vie, 6=Sáb)
        const hoy = new Date();
        const diaSemana = hoy.getDay();
        const fechaStr = hoy.toISOString().split('T')[0];
        console.log('📅 Fecha actual:', fechaStr, 'Día semana:', diaSemana);
        
        // Determinar qué tipo usar: T1 (Lun-Jue) o T3 (Vie)
        const esViernes = diaSemana === 5;
        const tipoEsperado = esViernes ? 'T3' : 'T1';
        console.log('🎯 Tipo esperado:', tipoEsperado, esViernes ? '(Viernes)' : '(Lun-Jue)');
        
        // Actualizar la UI según el día
        const card = document.getElementById('tasaActualCard');
        const label = document.getElementById('tasaActualLabel');
        if (esViernes) {
            card.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
            label.textContent = 'Caución T3 (Viernes)';
        } else {
            card.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            label.textContent = 'Caución T1 (Lun-Jue)';
        }
        
        // Leer de la nueva estructura: cauciones/{fecha}/lecturas
        const lecturasRef = collection(db, 'cauciones', fechaStr, 'lecturas');
        const qLecturas = query(lecturasRef, orderBy('fecha', 'desc'), limit(10));
        const snapshotLecturas = await getDocs(qLecturas);
        
        console.log('📊 Lecturas encontradas para hoy:', snapshotLecturas.size);
        
        let dataEncontrada = null;
        
        snapshotLecturas.forEach((doc) => {
            const data = doc.data();
            console.log('📄 Lectura:', doc.id, data);
            if (!dataEncontrada && data.tipo === tipoEsperado) {
                dataEncontrada = data;
            }
        });
        
        // Mostrar los datos
        if (dataEncontrada) {
            console.log(`✅ ${tipoEsperado} encontrado:`, dataEncontrada.tasa);
            document.getElementById('tasaActual').textContent = `${dataEncontrada.tasa.toFixed(2)}%`;
            const fecha = new Date(dataEncontrada.fecha);
            document.getElementById('fechaActual').textContent = 
                `Actualizado: ${fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
        } else {
            console.warn(`⚠️ No se encontró ${tipoEsperado}`);
            document.getElementById('tasaActual').textContent = '--';
            document.getElementById('fechaActual').textContent = 'Sin datos';
        }
    } catch (error) {
        console.error('❌ Error cargando tasas actuales:', error);
        console.error('Detalle:', error.message);
        document.getElementById('tasaActual').textContent = 'Error';
        document.getElementById('fechaActual').textContent = error.message;
    }
}

function mostrarSinDatosHistoricos() {
    document.getElementById('recordMax').textContent = '--';
    document.getElementById('recordFecha').textContent = 'Sin datos';
    document.getElementById('promedioMax').textContent = '--';
    document.getElementById('horaMasFrecuente').textContent = '--';
    document.getElementById('totalDias').textContent = '0';
    
    const historyTable = document.getElementById('historyTable');
    historyTable.innerHTML = '<p style="text-align: center; padding: 40px; color: #666;">📊 <strong>No hay datos todavía</strong><br><br>Los máximos diarios se registran automáticamente al final de cada día (~18:00).</p>';
    historyTable.classList.remove('loading');
    
    const hourChart = document.getElementById('hourChart');
    hourChart.innerHTML = '<p style="text-align: center; padding: 40px; color: #666;">Sin datos suficientes para mostrar el gráfico</p>';
    hourChart.classList.remove('loading');
}

function calcularEstadisticasCauciones(maximos) {
    console.log('📊 Calculando estadísticas con', maximos.length, 'registros');
    
    const record = maximos.reduce((max, m) => m.tasa_max > max.tasa_max ? m : max);
    console.log('🏆 Récord:', record.tasa_max, '%');
    document.getElementById('recordMax').textContent = `${record.tasa_max.toFixed(2)}%`;
    document.getElementById('recordFecha').textContent = formatearFechaCaucion(record.fecha);
    
    const ultimos7 = maximos.slice(0, 7);
    const promedio = ultimos7.reduce((sum, m) => sum + m.tasa_max, 0) / ultimos7.length;
    console.log('📊 Promedio últimos 7 días:', promedio, '%');
    document.getElementById('promedioMax').textContent = `${promedio.toFixed(2)}%`;
    
    const horas = maximos.map(m => m.hora_max.substring(0, 5));
    const frecuencias = {};
    horas.forEach(h => { frecuencias[h] = (frecuencias[h] || 0) + 1; });
    const horaMasFrecuente = Object.keys(frecuencias).reduce((a, b) => frecuencias[a] > frecuencias[b] ? a : b);
    console.log('⏰ Hora más frecuente:', horaMasFrecuente);
    document.getElementById('horaMasFrecuente').textContent = horaMasFrecuente;
    
    console.log('📅 Total días:', maximos.length);
    document.getElementById('totalDias').textContent = maximos.length;
    
    console.log('✅ Estadísticas calculadas correctamente');
}

function crearGraficoHorasCauciones(maximos) {
    console.log('📊 Creando gráfico de horas con', maximos.length, 'registros');
    
    const hourChartEl = document.getElementById('hourChart');
    if (!hourChartEl) {
        console.error('❌ No se encontró el elemento hourChart');
        return;
    }
    
    const horasCounts = {};
    for (let h = 9; h <= 18; h++) { horasCounts[h] = 0; }
    
    maximos.forEach(m => {
        if (!m.hora_max) {
            console.warn('⚠️ Registro sin hora_max:', m);
            return;
        }
        const hora = parseInt(m.hora_max.split(':')[0]);
        console.log('  Hora extraída:', hora, 'de', m.hora_max);
        if (hora >= 9 && hora <= 18) { horasCounts[hora]++; }
    });
    
    console.log('📈 Distribución de horas:', horasCounts);

    const maxCount = Math.max(...Object.values(horasCounts));
    console.log('📈 Máximo count:', maxCount);

    // Gráfico de líneas (SVG): escala solo, no se corta de alto
    const W = 620, H = 220;
    const padL = 24, padR = 16, padT = 28, padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const baseY = padT + plotH;

    const horas = [];
    for (let h = 9; h <= 18; h++) horas.push(h);
    const N = horas.length;

    const puntos = horas.map((h, i) => {
        const count = horasCounts[h];
        const x = padL + (N === 1 ? 0 : (i / (N - 1)) * plotW);
        const y = maxCount > 0 ? padT + (1 - count / maxCount) * plotH : baseY;
        return { x, y, count, h };
    });

    const linePoints = puntos.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = `M ${puntos[0].x.toFixed(1)},${baseY} `
        + puntos.map(p => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
        + ` L ${puntos[N - 1].x.toFixed(1)},${baseY} Z`;

    const svg = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
             style="width:100%; height:auto; display:block; background:white; border-radius:12px;">
            <defs>
                <linearGradient id="hourArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#667eea" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="#764ba2" stop-opacity="0.04"/>
                </linearGradient>
            </defs>
            <line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="#eee" stroke-width="1"/>
            <path d="${areaPath}" fill="url(#hourArea)"/>
            <polyline points="${linePoints}" fill="none" stroke="#667eea" stroke-width="2.5"
                      stroke-linejoin="round" stroke-linecap="round"/>
            ${puntos.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#fff" stroke="#764ba2" stroke-width="2"/>`).join('')}
            ${puntos.map(p => p.count > 0 ? `<text x="${p.x.toFixed(1)}" y="${(p.y - 9).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="bold" fill="#333">${p.count}</text>` : '').join('')}
            ${puntos.map(p => `<text x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#555">${p.h}h</text>`).join('')}
        </svg>`;

    hourChartEl.style.padding = '8px';
    hourChartEl.innerHTML = svg;
    hourChartEl.classList.remove('loading');
    console.log('✅ Gráfico de líneas insertado en el DOM');
}

function crearTablaHistorialCauciones(maximos) {
    console.log('📋 Creando tabla de historial con', maximos.length, 'registros');
    
    const historyTableEl = document.getElementById('historyTable');
    if (!historyTableEl) {
        console.error('❌ No se encontró el elemento historyTable');
        return;
    }
    
    // Tabla tipo Excel: layout fijo (entra justa, sin scroll horizontal) + scroll vertical interno
    const thBase = 'position: sticky; top: 0; z-index: 1; background: #6b46c1; color: #fff; text-align: left; word-break: break-word;';

    const filas = maximos.map((m, idx) => {
        const badgeStyle = m.tipo === 'T1' ? 'background: #e3f2fd; color: #1976d2;' : 'background: #f3e5f5; color: #7b1fa2;';
        const tipoBadge = `<span style="display: inline-block; padding: 2px 7px; border-radius: 8px; font-size: 11px; font-weight: bold; ${badgeStyle}">${m.tipo}</span>`;
        const fecha = formatearFechaCaucion(m.fecha);
        const zebra = idx % 2 ? 'background: #f7f7fb;' : 'background: #ffffff;';
        return `<tr style="${zebra} border-bottom: 1px solid #eee;">
            <td class="hist-td"><strong>${fecha}</strong></td>
            <td class="hist-td">${tipoBadge}</td>
            <td class="hist-td"><strong class="hist-tasa-val">${m.tasa_max.toFixed(2)}%</strong></td>
            <td class="hist-td hist-td-hora">${m.hora_max}</td>
        </tr>`;
    }).join('');

    const html = `
        <div class="hist-wrap">
            <div style="max-height: 420px; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; border: 1px solid #e5e7eb; border-radius: 12px; margin-top: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
                <table class="hist-table" style="width: 100%; table-layout: fixed; border-collapse: collapse; background: white;">
                    <thead>
                        <tr>
                            <th class="hist-th hist-fecha" style="${thBase}">Fecha</th>
                            <th class="hist-th hist-tipo" style="${thBase}">Tipo</th>
                            <th class="hist-th hist-tasa" style="${thBase}">Tasa</th>
                            <th class="hist-th hist-hora" style="${thBase} text-align: right;">Hora</th>
                        </tr>
                    </thead>
                    <tbody>${filas}</tbody>
                </table>
            </div>
            <div style="text-align: right; font-size: 12px; color: #999; margin-top: 6px;">${maximos.length} registros</div>
        </div>`;

    console.log('✅ Tabla HTML generada, aplicando al DOM...');
    historyTableEl.style.padding = '0';
    historyTableEl.style.textAlign = 'left';
    historyTableEl.innerHTML = html;
    historyTableEl.classList.remove('loading');
    console.log('✅ Tabla insertada en el DOM y clase loading removida');
}

function formatearFechaCaucion(fecha) {
    const [year, month, day] = fecha.split('-');
    const date = new Date(year, month - 1, day);
    const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    
    // Formato más compacto para mobile
    if (window.innerWidth <= 768) {
        return `${day}/${month} (${dias[date.getDay()]})`;
    }
    return `${day}/${month}/${year} (${dias[date.getDay()]})`;
}

async function descargarTelegramLogs() {
    const statusEl = document.getElementById('telegramLogsStatus');
    const btn = document.getElementById('downloadTelegramLogs');

    if (statusEl) {
        statusEl.textContent = 'Preparando CSV...';
        statusEl.className = 'caucion-log-status loading';
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Descargando...';
    }

    try {
        const db = getFirestore(window.firebaseApp);
        const logsQuery = query(collection(db, 'telegram_logs'), orderBy('fechaISO', 'desc'), limit(500));
        const snapshot = await getDocs(logsQuery);
        const logs = [];

        snapshot.forEach((docSnap) => {
            logs.push({ id: docSnap.id, ...docSnap.data() });
        });

        if (logs.length === 0) {
            if (statusEl) {
                statusEl.textContent = 'No hay logs de Telegram para descargar.';
                statusEl.className = 'caucion-log-status warning';
            }
            return;
        }

        const csv = crearCsvTelegramLogs(logs);
        const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const today = new Date().toISOString().slice(0, 10);

        link.href = url;
        link.download = `telegram-logs-${today}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        if (statusEl) {
            statusEl.textContent = `${logs.length} logs descargados.`;
            statusEl.className = 'caucion-log-status success';
        }
    } catch (error) {
        console.error('Error descargando logs de Telegram:', error);
        if (statusEl) {
            statusEl.textContent = `Error al descargar logs: ${error.message}`;
            statusEl.className = 'caucion-log-status error';
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Descargar logs Telegram';
        }
    }
}

function crearCsvTelegramLogs(logs) {
    const headers = [
        'fecha',
        'hora',
        'fechaISO',
        'tipo',
        'tasa',
        'telegramConfigured',
        'telegramSilenced',
        'telegramSent',
        'debeNotificar',
        'razon',
        'esPrimeraDelDia',
        'stopDetected',
        'stopSilenced',
        'updatesLeidos',
        'updatesDelChat',
        'lastUpdateId',
        'maxUpdateId',
        'telegramReadError',
        'telegramSendError',
        'telegramNotificationError',
        'method',
        'userAgent',
        'cauciones',
        'id'
    ];

    const rows = logs.map((log) => {
        const stopInfo = log.stopInfo || {};
        const cauciones = Array.isArray(log.cauciones) ? log.cauciones : [];
        const primeraCaucion = cauciones[0] || {};

        return [
            log.fecha || '',
            log.hora || '',
            log.fechaISO || '',
            primeraCaucion.tipo || '',
            formatCsvValueNumber(primeraCaucion.tasa),
            formatCsvValue(log.telegramConfigured),
            formatCsvValue(log.telegramSilenced),
            formatCsvValue(log.telegramSent),
            formatCsvValue(log.debeNotificar),
            log.razon || '',
            formatCsvValue(log.esPrimeraDelDia),
            formatCsvValue(stopInfo.stopDetected),
            formatCsvValue(stopInfo.silenced),
            formatCsvValue(stopInfo.updatesLeidos),
            formatCsvValue(stopInfo.updatesDelChat),
            formatCsvValue(stopInfo.lastUpdateId),
            formatCsvValue(stopInfo.maxUpdateId),
            log.telegramReadError || '',
            log.telegramSendError || '',
            log.telegramNotificationError || '',
            log.request?.method || '',
            log.request?.userAgent || '',
            cauciones.map(c => `${c.tipo || ''}:${formatCsvValueNumber(c.tasa)}`).join(' | '),
            log.id || ''
        ];
    });

    return [
        headers.join(','),
        ...rows.map(row => row.map(escapeCsvCell).join(','))
    ].join('\n');
}

function formatCsvValue(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

function formatCsvValueNumber(value) {
    if (value === null || value === undefined || value === '') return '';
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : String(value);
}

function escapeCsvCell(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

// Hacer la función global para que sea accesible desde script.js
window.cargarDashboardCauciones = cargarDashboardCauciones;

let caucionesInicializadas = false;

function initCaucionesDashboard() {
    if (caucionesInicializadas) return;
    caucionesInicializadas = true;

    console.log('🚀 DOM cargado, configurando listeners de cauciones');
    
    // Toggle configuración de cauciones
    const toggleBtn = document.getElementById('toggleCaucionConfig');
    const configPanel = document.getElementById('caucionConfigPanel');
    
    if (toggleBtn && configPanel) {
        console.log('✅ Botón de configuración encontrado');
        toggleBtn.addEventListener('click', () => {
            if (configPanel.style.display === 'none') {
                configPanel.style.display = 'block';
                toggleBtn.textContent = '▼ Ocultar Configuración';
            } else {
                configPanel.style.display = 'none';
                toggleBtn.textContent = '⚙️ Configuración de Notificaciones';
            }
        });
    } else {
        console.error('❌ No se encontró el botón o panel de configuración');
    }

    const downloadLogsBtn = document.getElementById('downloadTelegramLogs');
    if (downloadLogsBtn) {
        downloadLogsBtn.addEventListener('click', descargarTelegramLogs);
    }
    
    // Guardar configuración
    const saveBtn = document.getElementById('saveCaucionConfig');
    if (saveBtn) {
        console.log('✅ Botón de guardar configuración encontrado');
        saveBtn.addEventListener('click', async () => {
            const statusEl = document.getElementById('caucionConfigStatus');
            statusEl.textContent = '💾 Guardando...';
            statusEl.style.background = '#d1ecf1';
            statusEl.style.color = '#0c5460';
            
            try {
                const modo = document.querySelector('input[name="caucionModo"]:checked').value;
                const umbral = parseInt(document.querySelector('input[name="umbral"]:checked').value);
                
                const { setDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
                const db = getFirestore(window.firebaseApp);
                
                await setDoc(doc(db, 'config', 'notificaciones'), {
                    modo: modo,
                    umbral: umbral,
                    updatedAt: new Date()
                });
                
                statusEl.textContent = '✅ Configuración guardada correctamente';
                statusEl.style.background = '#d4edda';
                statusEl.style.color = '#155724';
            } catch (error) {
                console.error('Error guardando configuración:', error);
                statusEl.textContent = '❌ Error al guardar: ' + error.message;
                statusEl.style.background = '#f8d7da';
                statusEl.style.color = '#721c24';
            }
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCaucionesDashboard);
} else {
    initCaucionesDashboard();
}
