# Reglas de Firestore

Este documento resume las reglas reales del proyecto. La fuente de verdad es
`firestore.rules`; si hay dudas, revisa ese archivo antes de cambiar permisos.

## Despliegue

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

Los indices versionados estan en `firestore.indexes.json`.

## Modelo Actual

### `trades`

La app usa una sola estructura:

- `trades/{fecha}/items/{tradeId}`: trades organizados por fecha.

Reglas actuales:

- Cada usuario autenticado solo puede leer, crear, editar y borrar sus propios trades.
- Las queries `collectionGroup('items')` requieren la regla recursiva
  `match /{path=**}/items/{tradeId}`.
- La app filtra por `userId` en las queries y las reglas exigen ese mismo aislamiento.

### `tickers`

Ruta:

```text
tickers/{document=**}
```

Reglas actuales:

- Lectura permitida para usuarios autenticados.
- Escritura permitida solo al usuario admin.
- La lista de tickers funciona como catalogo compartido de la app.

### `bullrun`

Rutas:

```text
bullrun/{cripto}
bullrun/{cripto}/{subcoleccion}/{entryId}
```

Subcolecciones usadas:

- `compras`
- `ventas`

Reglas actuales:

- Cada usuario autenticado solo puede leer y escribir sus propias compras y ventas.
- El documento padre `bullrun/{cripto}` sigue funcionando como metadata compartida
  para que la coleccion sea visible en consola.
- Esta coleccion alimenta la pestaña Crypto.

### `cauciones`

Ruta:

```text
cauciones/{fecha}/lecturas/{document=**}
```

Reglas actuales:

- Lectura publica.
- Escritura denegada desde clientes.
- La escritura la realiza `api/scrape-caucion.js` con Firebase Admin SDK.

### `max_dia`

Ruta:

```text
max_dia/{document=**}
```

Reglas actuales:

- Lectura publica.
- Escritura denegada desde clientes.
- La escritura la realiza el scraper con Firebase Admin SDK.

### `telegram_logs`

Ruta:

```text
telegram_logs/{document=**}
```

Reglas actuales:

- Lectura permitida solo al usuario admin.
- Escritura denegada desde clientes.
- La escritura la realiza el scraper con Firebase Admin SDK para diagnosticar decisiones de Telegram.

### `config`

Ruta:

```text
config/{document=**}
```

Reglas actuales:

- Lectura permitida para usuarios autenticados.
- Escritura permitida solo para `garcialeonel1990@gmail.com`.
- Se usa para configuraciones como notificaciones de cauciones.

## Indices

### `items` collection group

Usados por consultas sobre trades organizados por fecha:

- `ticker ASC`, `userId ASC`
- `userId ASC`, `ticker ASC`

### `lecturas`

Usado por el dashboard de cauciones:

- `tipo ASC`, `fecha DESC`

### `max_dia`

Usado para historial de maximos diarios:

- `fecha DESC`

## Checklist Para Cambios

Antes de cambiar reglas:

1. Verificar las queries en `src/js/managers/trades-manager.js`.
2. Verificar las lecturas de cauciones en `index.html`.
3. Verificar el modelo de Crypto en `src/js/managers/bullrun-manager.js`.
4. Actualizar `firestore.indexes.json` si una query nueva necesita indice.
5. Probar login, dashboard, alta de trade, Crypto y cauciones.
