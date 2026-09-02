// API endpoint para ejecutar el scraper de cauciones
// Puede ser llamado desde servicios de cron externos o manualmente

import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import admin from 'firebase-admin';

// Inicializar Firebase Admin
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

// Configuración de Argentina
const ARGENTINA_TZ = 'America/Argentina/Buenos_Aires';

function getArgentinaDateString(date) {
    const arDate = new Date(date.toLocaleString('en-US', { timeZone: ARGENTINA_TZ }));
    return arDate.toISOString().split('T')[0];
}

function isStopCommand(text) {
    const normalized = text?.trim().toLowerCase();
    return normalized === 'stop' || normalized === '/stop';
}

function nullableInteger(value) {
    return Number.isInteger(value) ? value : null;
}

async function procesarStopTelegram(fechaHoy) {
    const botStateRef = db.collection('config').doc('telegram_bot');
    const silenceRef = db.collection('config').doc('telegram_silencio');

    const botStateDoc = await botStateRef.get();
    const lastUpdateId = botStateDoc.exists ? botStateDoc.data().lastUpdateId : undefined;
    const body = {
        timeout: 0,
        allowed_updates: ['message']
    };

    if (Number.isInteger(lastUpdateId)) {
        body.offset = lastUpdateId + 1;
    }

    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`Telegram getUpdates HTTP ${response.status}`);
    }

    const result = await response.json();
    if (!result.ok) {
        throw new Error(result.description || 'Telegram getUpdates failed');
    }

    let maxUpdateId = lastUpdateId;
    let stopDetectadoHoy = false;
    let updatesLeidos = 0;
    let updatesDelChat = 0;

    for (const update of result.result || []) {
        updatesLeidos++;

        if (Number.isInteger(update.update_id) && (!Number.isInteger(maxUpdateId) || update.update_id > maxUpdateId)) {
            maxUpdateId = update.update_id;
        }

        const message = update.message;
        if (!message || String(message.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID)) {
            continue;
        }

        updatesDelChat++;
        const messageDate = message.date ? getArgentinaDateString(new Date(message.date * 1000)) : null;
        if (messageDate === fechaHoy && isStopCommand(message.text)) {
            stopDetectadoHoy = true;
        }
    }

    if (Number.isInteger(maxUpdateId)) {
        await botStateRef.set({
            lastUpdateId: maxUpdateId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    if (stopDetectadoHoy) {
        await silenceRef.set({
            activo: true,
            fecha: fechaHoy,
            chatId: process.env.TELEGRAM_CHAT_ID,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log('[Scraper API] 🔕 Stop recibido por Telegram; notificaciones silenciadas por hoy');
        return {
            silenced: true,
            stopDetected: true,
            lastUpdateId: nullableInteger(lastUpdateId),
            maxUpdateId: nullableInteger(maxUpdateId),
            updatesLeidos,
            updatesDelChat
        };
    }

    const silenceDoc = await silenceRef.get();
    const silence = silenceDoc.exists ? silenceDoc.data() : {};
    return {
        silenced: silence.activo === true && silence.fecha === fechaHoy && String(silence.chatId) === String(process.env.TELEGRAM_CHAT_ID),
        stopDetected: false,
        lastUpdateId: nullableInteger(lastUpdateId),
        maxUpdateId: nullableInteger(maxUpdateId),
        updatesLeidos,
        updatesDelChat
    };
}

async function guardarTelegramLog(data) {
    try {
        const docId = `${data.fecha}_${data.hora.replace(':', '-')}_${Date.now()}`;
        await db.collection('telegram_logs').doc(docId).set({
            fecha: data.fecha,
            hora: data.hora,
            fechaISO: data.fechaISO,
            cauciones: data.cauciones,
            config: data.config,
            esPrimeraDelDia: data.esPrimeraDelDia,
            debeNotificar: data.debeNotificar,
            razon: data.razon,
            telegramSent: data.telegramSent,
            telegramSilenced: data.telegramSilenced,
            telegramConfigured: data.telegramConfigured,
            stopInfo: data.stopInfo,
            telegramReadError: data.telegramReadError,
            telegramSendError: data.telegramSendError,
            telegramNotificationError: data.telegramNotificationError,
            request: {
                method: data.method,
                userAgent: data.userAgent
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error('[Scraper API] ❌ Error guardando telegram_logs:', error.message);
    }
}

function isAuthorizedCronRequest(req) {
    if (!process.env.CRON_SECRET) {
        throw new Error('CRON_SECRET is required for scraper authorization');
    }

    const authToken = req.headers.authorization || '';
    return authToken === `Bearer ${process.env.CRON_SECRET}`;
}

export default async function handler(req, res) {
    // Verificar método
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Verificar token de seguridad del cron por header Authorization.
    let authorized = false;
    try {
        authorized = isAuthorizedCronRequest(req);
    } catch (error) {
        console.error('[Scraper API] Config error:', error.message);
        return res.status(500).json({ error: 'Scraper authorization is not configured' });
    }

    if (!authorized) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        console.log('[Scraper API] 🚀 Iniciando scraper...');

        // Verificar si estamos en horario de mercado (hora de Argentina)
        const now = new Date();
        const arTime = new Date(now.toLocaleString('en-US', { timeZone: ARGENTINA_TZ }));
        const hora = arTime.getHours();
        const minutos = arTime.getMinutes();
        const dia = arTime.getDay(); // 0 = domingo, 1 = lunes, ..., 5 = viernes

        // Solo ejecutar de lunes a viernes (1-5), de 10:30 AM a 5 PM
        if (dia === 0 || dia === 6) {
            console.log('[Scraper API] ⏰ Hoy es fin de semana, no se ejecuta');
            return res.status(200).json({ 
                message: 'Fin de semana - no se ejecuta',
                timestamp: now.toISOString()
            });
        }

        // Verificar horario: 10:30 - 17:00
        const dentroDeHorario = (hora === 10 && minutos >= 30) || 
                                 (hora >= 11 && hora < 17) || 
                                 (hora === 17 && minutos === 0);
        
        if (!dentroDeHorario) {
            console.log(`[Scraper API] ⏰ Fuera de horario (${hora}:${minutos.toString().padStart(2, '0')}) - no se ejecuta`);
            return res.status(200).json({ 
                message: `Fuera de horario (${hora}:${minutos.toString().padStart(2, '0')}) - mercado cerrado (horario: 10:30-17:00)`,
                timestamp: now.toISOString()
            });
        }

        // Obtener página de cauciones
        console.log('[Scraper API] ⏳ Obteniendo página de cauciones...');
        const response = await fetch('https://iol.invertironline.com/mercado/cotizaciones/argentina/cauciones', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const html = await response.text();
        const dom = new JSDOM(html);
        const document = dom.window.document;

        console.log('[Scraper API] ✅ Página obtenida. Parseando HTML...');

        const rows = document.querySelectorAll('table tbody tr');
        const cauciones = [];
        
        // Estadísticas para sacar promedio
        const tasasT1 = [];
        const tasasT3 = [];

        rows.forEach((row, index) => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 7) {
                // Extraer el plazo de la primera columna (dentro del <strong>)
                const plazoElement = cols[0]?.querySelector('strong');
                const plazo = plazoElement?.textContent?.trim() || '';
                
                const moneda = cols[1]?.textContent?.trim() || '';
                const tasaText = cols[5]?.textContent?.trim() || '';
                
                // Solo procesar si es PESOS
                if (moneda === 'PESOS' && tasaText) {
                    const tasa = parseFloat(tasaText.replace(',', '.').replace('%', '').trim());
                    if (!isNaN(tasa) && tasa > 0) {
                        // Clasificar según el plazo real de la columna
                        if (plazo === '1') {
                            tasasT1.push(tasa);
                        } else if (plazo === '3') {
                            tasasT3.push(tasa);
                        }
                    }
                }
            }
        });
        
        // Calcular promedios
        // Determinar qué tipo usar según el día de la semana
        const esViernes = dia === 5;
        const tipoHoy = esViernes ? 'T3' : 'T1';
        
        console.log(`[Scraper API] 📅 Día de la semana: ${dia} (${esViernes ? 'Viernes' : 'Lun-Jue'}) → Guardar solo ${tipoHoy}`);
        
        if (tipoHoy === 'T1' && tasasT1.length > 0) {
            const promedioT1 = tasasT1.reduce((a, b) => a + b, 0) / tasasT1.length;
            cauciones.push({ 
                nombre: `PESOS T1 (prom ${tasasT1.length} operaciones)`, 
                tipo: 'T1', 
                tasa: Math.round(promedioT1 * 100) / 100 
            });
        }
        
        if (tipoHoy === 'T3' && tasasT3.length > 0) {
            const promedioT3 = tasasT3.reduce((a, b) => a + b, 0) / tasasT3.length;
            cauciones.push({ 
                nombre: `PESOS T3 (prom ${tasasT3.length} operaciones)`, 
                tipo: 'T3', 
                tasa: Math.round(promedioT3 * 100) / 100 
            });
        }

        if (cauciones.length === 0) {
            console.log('[Scraper API] ⚠️ No se encontraron cauciones');
            return res.status(200).json({ 
                message: 'No se encontraron cauciones en la página',
                timestamp: now.toISOString()
            });
        }

        console.log(`[Scraper API] 📊 Cauciones encontradas: ${cauciones.length}`);

        // Preparar variables para guardar
        const fechaHoy = arTime.toISOString().split('T')[0]; // YYYY-MM-DD
        const horaActual = `${arTime.getHours().toString().padStart(2, '0')}:${arTime.getMinutes().toString().padStart(2, '0')}`;
        const fechaISO = now.toISOString();
        
        // PASO 1: Obtener lecturas anteriores ANTES de guardar las nuevas
        let lecturasAnteriores = {};
        
        if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            try {
                const lecturasAnterioresSnapshot = await db.collection('cauciones')
                    .doc(fechaHoy)
                    .collection('lecturas')
                    .orderBy('fecha', 'desc')
                    .limit(5)
                    .get();
                
                // Guardar las tasas anteriores por tipo
                lecturasAnterioresSnapshot.forEach(doc => {
                    const data = doc.data();
                    if (!lecturasAnteriores[data.tipo]) {
                        lecturasAnteriores[data.tipo] = data;
                    }
                });
                
                const esPrimeraDelDia = lecturasAnterioresSnapshot.empty;
                console.log(`[Scraper API] 📊 Es primera del día: ${esPrimeraDelDia}, Lecturas anteriores encontradas: ${Object.keys(lecturasAnteriores).length}`);
                
            } catch (error) {
                console.error('[Scraper API] ❌ Error obteniendo lecturas anteriores:', error.message);
            }
        }

        // PASO 2: Guardar las nuevas lecturas en Firestore
        const batch = db.batch();

        cauciones.forEach(c => {
            // Crear ID descriptivo: {fecha}_{hora}_{tipo}
            // Ejemplo: 2026-02-11_14-30_T1
            const docId = `${fechaHoy}_${horaActual.replace(':', '-')}_${c.tipo}`;
            
            // Guardar en subcollection: cauciones/{fecha}/lecturas/{fecha_hora_tipo}
            const docRef = db.collection('cauciones').doc(fechaHoy).collection('lecturas').doc(docId);
            batch.set(docRef, {
                nombre: c.nombre,
                tipo: c.tipo,
                tasa: c.tasa,
                hora: horaActual,
                fecha: fechaISO,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        await batch.commit();
        console.log(`[Scraper API] ✅ Datos guardados en cauciones/${fechaHoy}/lecturas`);

        // Variable para tracking de notificaciones
        let telegramSent = false;
        let telegramSilenced = false;
        let debeNotificar = false;
        let razon = '';
        let config = null;
        let stopInfo = null;
        let telegramReadError = null;
        let telegramSendError = null;
        let telegramNotificationError = null;
        const telegramConfigured = Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID);
        if (!telegramConfigured) {
            razon = 'Telegram no configurado';
        }
        const esPrimeraDelDia = Object.keys(lecturasAnteriores).length === 0;

        // Actualizar máximos del día
        for (const caucion of cauciones) {
            const maxDiaRef = db.collection('max_dia').doc(`${fechaHoy}_${caucion.tipo}`);
            const maxDiaDoc = await maxDiaRef.get();
            
            if (!maxDiaDoc.exists || caucion.tasa > maxDiaDoc.data().tasa_max) {
                await maxDiaRef.set({
                    fecha: fechaHoy,
                    hora_max: horaActual,
                    tasa_max: caucion.tasa,
                    tipo: caucion.tipo,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`[Scraper API] 🏆 Nuevo máximo del día ${caucion.tipo}: ${caucion.tasa}% a las ${horaActual}`);
            }
        }

        // Evaluar notificaciones
        if (telegramConfigured) {
            try {
                try {
                    stopInfo = await procesarStopTelegram(fechaHoy);
                    telegramSilenced = stopInfo.silenced;
                    if (telegramSilenced) {
                        console.log('[Scraper API] 🔕 Telegram silenciado para el día de hoy');
                    }
                } catch (error) {
                    telegramReadError = error.message;
                    console.error('[Scraper API] ❌ Error leyendo comandos Telegram:', error.message);
                }

                // Leer configuración desde Firestore
                const configDoc = await db.collection('config').doc('notificaciones').get();
                config = configDoc.exists ? configDoc.data() : { modo: 'variacion', umbral: 1 };
                
                console.log(`[Scraper API] 📋 Config: modo=${config.modo}, umbral=${config.umbral}%`);
                
                if (esPrimeraDelDia) {
                    debeNotificar = true;
                    razon = '🌅 Primera lectura del día';
                } else if (config.modo === 'siempre') {
                    debeNotificar = true;
                    razon = 'Modo: siempre';
                } else if (config.modo === 'variacion') {
                    // Verificar variación para cada tipo de caución
                    for (const caucion of cauciones) {
                        const lecturaAnterior = lecturasAnteriores[caucion.tipo];
                        
                        if (lecturaAnterior) {
                            const variacionAbsoluta = Math.abs(caucion.tasa - lecturaAnterior.tasa);
                            const variacionPorcentual = (variacionAbsoluta / lecturaAnterior.tasa) * 100;
                            
                            console.log(`[Scraper API] 📊 ${caucion.tipo}: ${lecturaAnterior.tasa}% → ${caucion.tasa}% (variación: ${variacionAbsoluta.toFixed(2)}pp, ${variacionPorcentual.toFixed(2)}%)`);
                            
                            if (variacionPorcentual >= config.umbral) {
                                debeNotificar = true;
                                const direccion = caucion.tasa > lecturaAnterior.tasa ? '↗️' : '↘️';
                                const nuevaRazon = `${caucion.tipo} ${direccion} ${variacionAbsoluta.toFixed(2)}pp / ${variacionPorcentual.toFixed(2)}% (${lecturaAnterior.tasa}% → ${caucion.tasa}%)`;
                                razon = razon ? `${razon}\n${nuevaRazon}` : nuevaRazon;
                            }
                        } else {
                            console.log(`[Scraper API] ⚠️ No hay lectura anterior para ${caucion.tipo}`);
                        }
                    }
                    
                    if (!debeNotificar) {
                        razon = 'Sin variación significativa';
                    }
                } else {
                    razon = 'Notificaciones desactivadas';
                }
                
                console.log(`[Scraper API] 🔔 ${razon}`);
                
                if (debeNotificar && !telegramSilenced) {
                    const t1 = cauciones[0];

                    const telegramResponse = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: process.env.TELEGRAM_CHAT_ID,
                            text: `<b>${t1.tipo}: ${t1.tasa.toFixed(2)}%</b>\n${razon}\n${arTime.toLocaleString('es-AR')}`,
                            parse_mode: 'HTML'
                        })
                    });

                    if (!telegramResponse.ok) {
                        telegramSendError = `Telegram sendMessage HTTP ${telegramResponse.status}`;
                        throw new Error(telegramSendError);
                    }

                    const telegramResult = await telegramResponse.json();
                    if (!telegramResult.ok) {
                        telegramSendError = telegramResult.description || 'Telegram sendMessage failed';
                        throw new Error(telegramSendError);
                    }

                    telegramSent = true;
                    console.log('[Scraper API] ✅ Notificación enviada a Telegram');
                } else if (debeNotificar && telegramSilenced) {
                    console.log('[Scraper API] 🔕 Notificación omitida por stop de Telegram');
                }
            } catch (error) {
                telegramNotificationError = error.message;
                console.error('[Scraper API] ❌ Error en notificaciones Telegram:', error.message);
            }
        }

        await guardarTelegramLog({
            fecha: fechaHoy,
            hora: horaActual,
            fechaISO,
            cauciones,
            config,
            esPrimeraDelDia,
            debeNotificar,
            razon,
            telegramSent,
            telegramSilenced,
            telegramConfigured,
            stopInfo,
            telegramReadError,
            telegramSendError,
            telegramNotificationError,
            method: req.method,
            userAgent: req.headers['user-agent'] || ''
        });

        return res.status(200).json({
            success: true,
            message: 'Scraper ejecutado correctamente',
            data: {
                cauciones,
                timestamp: fechaISO,
                telegramSent,
                telegramSilenced
            }
        });

    } catch (error) {
        console.error('[Scraper API] ❌ Error:', error);
        return res.status(500).json({
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}
