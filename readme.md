# 📊 Trades Logger

Sistema completo de seguimiento de inversiones con tracking en tiempo real de CEDEARs y monitoreo automático de tasas de caución.

## 🌟 Características

### Trading Management
- 📈 **Tracking de CEDEARs** - Seguimiento en tiempo real con precios de Yahoo Finance
- 💰 **Cálculo LIFO** - Gestión automática de ganancias/pérdidas
- 📊 **Dashboard** - Métricas completas de performance
- 🎯 **Gestión de Tickers** - CRUD completo de activos
- 🔄 **Actualización en tiempo real** - Botón de refresh integrado

### Crypto Portfolio
- 🪙 **Registro de compras y ventas** - BTC, HYPE y SOL
- 📊 **Dashboard de portafolio** - Valor actual, capital invertido y resultados
- 📈 **Ganancias realizadas/no realizadas** - Cálculos según el promedio ponderado actual
- 🔎 **Detalle por activo** - Historial de compras y trades cerrados

### Caución Tracker
- 🤖 **Scraper automático** - Obtiene tasas de IOL cada 5 minutos (10:30-17:00 hs)
- 📱 **Alertas Telegram** - Notificaciones inteligentes por variación
- 📉 **Dashboard analítico** - Estadísticas de máximos históricos y tasas en tiempo real
- ⏰ **cron-job.org** - Ejecución confiable cada 5 minutos durante horario de mercado
- 🏆 **Máximos diarios** - Registro automático del pico del día (~17:00 hs)

## 🚀 Tech Stack

- **Frontend**: HTML5, CSS3, JavaScript ES6+ (Vanilla)
- **Backend**: Firebase (Auth, Firestore)
- **Serverless**: Vercel Functions (Node.js)
- **Automation**: cron-job.org (scheduler externo)
- **APIs**: Yahoo Finance, IOL, Telegram Bot API

## 📁 Estructura del Proyecto

```
tradeslogger/
├── index.html                 # Aplicación principal SPA
├── package.json              # Configuración del proyecto
├── vercel.json               # Config de deployment
├── firestore.rules           # Reglas de seguridad
├── firestore.indexes.json    # Índices compuestos
├── README.md                 # Este archivo
│
├── api/                       # Vercel Serverless Functions
│   ├── scrape-caucion.js     # Scraper de cauciones (Node.js)
│   ├── stock-price.js        # API de precio unitario/histórico de Yahoo Finance
│   └── stock-prices.js       # API de precios actuales en lote
│
├── docs/                      # Documentación
│   ├── FIRESTORE_RULES.md    # Reglas e índices de Firestore
│   └── SETUP-CRON-VERCEL.md  # Instrucciones de configuración cron-job.org
│
└── src/                       # Código fuente del frontend
    ├── config/
    │   └── config-public.js  # Configuración pública de Firebase
    ├── js/
    │   ├── apple-touch-icon.js
    │   ├── cauciones-dashboard.js
    │   ├── crypto-dashboard.js
    │   ├── script.js         # Lógica principal de la app
    │   ├── version-info.js
    │   ├── auth/             # Módulos de autenticación
    │   │   ├── firebase-init.js
    │   │   └── firebase-auth.js
    │   ├── managers/         # Gestión de datos
    │   │   ├── bullrun-manager.js
    │   │   ├── tickers-manager.js
    │   │   └── trades-manager.js
    └── styles/
        └── styles.css        # Estilos de la aplicación
```

## 🔧 Setup

### Prerrequisitos
- Cuenta Firebase (plan gratuito suficiente)
- Cuenta Vercel (plan gratuito suficiente)
- Cuenta cron-job.org (plan gratuito suficiente)
- Bot de Telegram (opcional, para alertas)

### 1. Configurar Firebase

1. **Crear proyecto**
   - Ve a [Firebase Console](https://console.firebase.google.com)
   - Crea un nuevo proyecto

2. **Habilitar Authentication**
   - Ve a Authentication → Sign-in method
   - Habilita "Email/Password"
   - Crea tu primer usuario

3. **Crear Firestore Database**
   - Ve a Firestore Database
   - Crear base de datos (modo producción)

4. **Actualizar config pública**
   - Edita `src/config/config-public.js`
   - Pega tus credenciales públicas de Firebase

5. **Generar Service Account** (para el scraper)
   - Project Settings → Service Accounts
   - Generate new private key
   - Descarga el archivo JSON

6. **Desplegar reglas e índices**
   ```bash
   firebase deploy --only firestore:rules
   firebase deploy --only firestore:indexes
   ```

### 2. Configurar Vercel

1. **Deploy inicial**
   ```bash
   npm install -g vercel
   vercel login
   vercel
   ```

2. **Configurar Variables de Entorno**
   
   En Vercel Dashboard → Settings → Environment Variables:
   
   | Variable | Descripción |
   |----------|-------------|
   | `FIREBASE_PROJECT_ID` | ID del proyecto Firebase |
   | `FIREBASE_PRIVATE_KEY` | Private key del service account (completa) |
   | `FIREBASE_CLIENT_EMAIL` | Client email del service account |
   | `CRON_SECRET` | Token requerido para proteger el endpoint de cron |
   | `ADMIN_EMAIL` | Email autorizado para sincronizar la master de CEDEARs |
   | `TELEGRAM_TOKEN` | Token del bot de Telegram |
   | `TELEGRAM_CHAT_ID` | Tu chat ID de Telegram |

3. **Redeploy**
   ```bash
   vercel --prod
   ```

### 3. Configurar cron-job.org

Ver instrucciones completas en [`docs/SETUP-CRON-VERCEL.md`](docs/SETUP-CRON-VERCEL.md)

**Resumen rápido:**
1. Registrarse en https://cron-job.org
2. Crear cronjob:
   - URL: `https://tu-app.vercel.app/api/scrape-caucion`
   - Schedule: Cada 5 minutos
   - Días: Lunes a Viernes
   - Horario: 13:30-20:00 UTC (10:30-17:00 Argentina)

### 4. Configurar Telegram Bot (Opcional)

1. Habla con [@BotFather](https://t.me/BotFather)
2. Envía `/newbot` y sigue las instrucciones
3. Guarda el token
4. Obtén tu Chat ID con [@getmyid_bot](https://t.me/getmyid_bot)

## 💻 Desarrollo Local

```bash
# Servidor local simple
npm run dev

# Visita http://localhost:8000
```

**Nota:** Las Vercel Functions solo funcionan en producción. Para testing local del scraper, usa la función de "Run now" en cron-job.org.

## 📊 Firestore Collections

### `trades`
```javascript
{
  userId: string,
  ticker: string,
  tipo: "COMPRA" | "VENTA",
  cantidad: number,
  priceCedear: number,
  total: number,
  fecha: string,
  timestamp: timestamp
}
```

### `tickers`
```javascript
{
  ticker: string,
  nombre: string,
  ratio: number,
  priceCedear: number,
  createdAt: timestamp
}
```

### `bullrun/{cripto}/compras`
```javascript
{
  userId: string,
  cripto: "BTC" | "HYPE" | "SOL",
  fecha: string,
  precio: number,
  cantidad: number,
  timestamp: timestamp
}
```

### `bullrun/{cripto}/ventas`
```javascript
{
  userId: string,
  cripto: "BTC" | "HYPE" | "SOL",
  fecha: string,
  precio: number,
  cantidad: number,
  costoBase: number,
  ganancia: number,
  gananciaPct: number,
  timestamp: timestamp
}
```

### `cauciones`
```javascript
{
  tasa: number,
  tasaTexto: string,
  tipo: "T1" | "T3",
  fecha: string,
  timestamp: serverTimestamp,
  dia: number
}
```

### `max_dia`
```javascript
{
  fecha: string,
  hora: string,
  tasa: number,
  tipo: "T1" | "T3"
}
```

## 🔐 Seguridad

- ✅ Autenticación requerida para trades y lectura de tickers
- ✅ Escritura de tickers restringida al usuario admin
- ✅ Reglas de Firestore restrictivas por usuario
- ✅ Cauciones: lectura pública, escritura solo via service account
- ✅ CORS habilitado en serverless functions
- ✅ Variables de entorno para credenciales sensibles
- ✅ Validación de horario en el scraper

## 🎯 Roadmap

- [ ] Gráficos de performance histórica con Chart.js
- [ ] Exportar datos a CSV/Excel
- [ ] Multi-usuario con portfolios separados
- [ ] Alertas personalizadas por ticker
- [ ] Integración con más brokers argentinos
- [ ] PWA (Progressive Web App) para instalación mobile
- [ ] Modo oscuro

## 📖 Documentación Adicional

- [Reglas de Firestore](docs/FIRESTORE_RULES.md) - Reglas e índices actuales
- [Setup cron-job.org](docs/SETUP-CRON-VERCEL.md) - Configuración del scheduler

## 🤝 Contribuir

Las contribuciones son bienvenidas. Por favor:

1. Fork el proyecto
2. Crea tu feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la branch (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## 📝 Licencia

MIT

## 👤 Autor

**Leonel Garcia**
- Email: [garcialeonel1990@gmail.com](mailto:garcialeonel1990@gmail.com)
- GitHub: [@leonelgarcia1990](https://github.com/leonelgarcia1990)

---

⭐ Si te resultó útil, dale una estrella al repo!
