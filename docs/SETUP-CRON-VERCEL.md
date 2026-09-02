# Instrucciones: Scraper de Cauciones con Vercel + cron-job.org

## 🚀 Configuración Completa

### **Paso 1: Configurar Variables de Entorno en Vercel**

Ve a tu proyecto en Vercel → Settings → Environment Variables y agrega:

| Variable | Valor |
|----------|-------|
| `FIREBASE_PROJECT_ID` | Tu project ID de Firebase |
| `FIREBASE_PRIVATE_KEY` | La private key completa (con `BEGIN` y `END`) |
| `FIREBASE_CLIENT_EMAIL` | Email del service account |
| `CRON_SECRET` | Token fuerte para proteger el endpoint |
| `TELEGRAM_TOKEN` | Token de tu bot de Telegram |
| `TELEGRAM_CHAT_ID` | Tu chat ID numérico |

⚠️ **IMPORTANTE:** En `FIREBASE_PRIVATE_KEY`, pega la key completa con saltos de línea. Vercel la manejará correctamente.

---

### **Paso 2: Deployar a Vercel**

```bash
# Desde la terminal de este proyecto
vercel --prod
```

O haz commit y push si tienes integración con GitHub - Vercel deployará automáticamente.

**Tu endpoint será:**
```
https://TU-APP.vercel.app/api/scrape-caucion
```

---

### **Paso 3: Probar Manualmente**

Usa curl enviando el header de autorización:

```bash
curl -X POST https://TU-APP.vercel.app/api/scrape-caucion \
  -H "Authorization: Bearer TU_CRON_SECRET"
```

Deberías ver:
```json
{
  "success": true,
  "message": "Scraper ejecutado correctamente",
  "data": {
    "cauciones": [
      {
        "nombre": "PESOS T1 (prom 10 operaciones)",
        "tipo": "T1",
        "tasa": 45.5
      }
    ],
    "timestamp": "2026-02-03T14:30:00.000Z",
    "telegramSent": true,
    "telegramSilenced": false
  }
}
```

---

### **Paso 4: Configurar cron-job.org (5 minutos)**

1. **Crear cuenta:**
   - Ve a https://cron-job.org
   - Regístrate gratis (plan Free = 50 cron jobs)

2. **Crear nuevo Cron Job:**
   - Click en "Cronjobs" → "Create cronjob"
   
3. **Configuración:**

   **Title:** `Scraper Cauciones IOL`
   
   **URL:** 
   ```
   https://TU-APP.vercel.app/api/scrape-caucion
   ```
   
   **Schedule:**
   - **Every:** `5 minutes`
   - **Days:** Lunes a Viernes (Monday to Friday)
   - **Time:** `13:30 - 20:00` (UTC) = `10:30 - 17:00` Argentina
   
   **Request method:** `GET` o `POST` (ambos funcionan)
   
   **Headers:**
   ```
   Authorization: Bearer TU_CRON_SECRET
   ```
   
   **Timeout:** `30 seconds`

4. **Guardar** y activar ✅

---

### **Paso 5: Verificar que Funciona**

1. En cron-job.org verás el historial de ejecuciones
2. En Firebase verás los documentos en la colección `cauciones`
3. En Telegram recibirás notificaciones según tu configuración

---

## 📊 Resultado

✅ **Cada 5 minutos** (10:30-17:00, Lun-Vie) → cron-job.org llama a tu API  
✅ **Vercel ejecuta** el scraper Node.js
✅ **Guarda datos** en Firebase  
✅ **Envía notificaciones** a Telegram según config  

**Todo 100% GRATIS**

---

## 🔧 Troubleshooting

**Error: "Module not found"**
- Verifica que `api/package.json` incluye `firebase-admin`, `jsdom` y `node-fetch`
- Revisa el log de build/deploy en Vercel

**Error: Firebase authentication**
- Revisa que las variables de entorno estén configuradas correctamente
- La PRIVATE_KEY debe incluir `-----BEGIN PRIVATE KEY-----` y `-----END PRIVATE KEY-----`

**No recibo notificaciones de Telegram**
- Verifica `TELEGRAM_TOKEN` y `TELEGRAM_CHAT_ID`
- Prueba manualmente el endpoint

**El cron no se ejecuta a las horas correctas**
- Verifica que configuraste **UTC time zone** en cron-job.org
- 13:30 UTC = 10:30 Argentina
