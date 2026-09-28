# GymNAZA — openGym en Railway

Despliegue personal de [openGym](https://github.com/DuarteSantos8/openGym) (AGPL-3.0, repo oficial
verificado: no es un fork; GitHub es el original y GitLab es su espejo) en Railway.

- **URL actual:** https://web-production-cddc0.up.railway.app (dominio gratuito de Railway, con HTTPS)
- **Versión de openGym:** 1.3.8 (fija: no se actualiza sola)
- **Railway:** workspace *lmtmlatam's Projects* → proyecto **opengym** → entorno **production**

## Cómo está armado

```
iPhone ──HTTPS──> [web]  nginx: sirve la app + imágenes, y reenvía /api/* a la API
                    │     único servicio con dominio público
                    │     red privada de Railway: http://api.railway.internal:8080
                    ▼
                  [api]  Node: passkeys + tus datos en archivos JSON
                          volumen persistente "api-volume" montado en /data
```

| Servicio | Origen | Volumen | Dominio público |
|---|---|---|---|
| `api` | `railway/api/Dockerfile` de este repo (imagen oficial `opengym-api:1.3.8` + conector MCP) | `api-volume` → `/data` | no |
| `web` | `railway/web/Dockerfile` de este repo (imagen oficial `opengym-web:1.3.8` + imágenes de ejercicios + DNS de Railway) | no hace falta | sí |

**Por qué hay un Dockerfile propio para web:** en docker-compose, un servicio `media` descarga las
imágenes a una carpeta compartida. En Railway un volumen no se comparte entre servicios, así que las
imágenes (1324 JPG + 1324 GIF, ~140 MB) se descargan durante el build y quedan dentro de la imagen. Además:

- nginx usa el DNS interno de Railway en lugar del de Docker (`RESOLVER=auto`, que Railway resuelve a `[fd12::10]`).
- Se aceptan direcciones IPv6, que usa la red privada de Railway.

Imágenes y GIFs: © Gym visual, usados bajo los términos del dataset `hasaneyldrm/exercises-dataset`
(ver `NOTICE.md` de openGym).

### Variables de entorno

**api**

| Variable | Valor | Para qué |
|---|---|---|
| `RP_ID` | `web-production-cddc0.up.railway.app` | hostname de las passkeys: sin `https://`, sin `/` |
| `ORIGIN` | `https://web-production-cddc0.up.railway.app` | origen exacto: con `https://`, sin `/` final |
| `RP_NAME` | `openGym` | nombre que muestra el iPhone al crear la passkey |
| `PORT` | `8080` | puerto de la API |
| `DATA_DIR` | `/data` | carpeta de datos (= volumen) |
| `ADMIN_UIDS` | tu id de usuario (ver `/api/me`) | te da el panel de administración en Ajustes |
| `INVITE_ONLY` | `1` | para crear un perfil nuevo hace falta un código de invitación |
| `ALLOW_GUEST` | `0` | sin botón "Continuar sin cuenta" |

**web**

| Variable | Valor | Para qué |
|---|---|---|
| `NGINX_PORT` | `8080` | puerto de nginx (Railway hace el health check en `PORT`, por eso coinciden) |
| `PORT` | `8080` | puerto de la API al que reenvía nginx |
| `BACKEND` | `${{api.RAILWAY_PRIVATE_DOMAIN}}` | se completa solo con `api.railway.internal` |
| `RESOLVER` | `auto` | DNS del contenedor |
| `NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE` | `1` | ajusta los procesos de nginx a la CPU asignada (48 → 8) |

Otras opcionales (ver `.env.example` de openGym): `SESSION_DAYS`, `AUDIT_IP`, `VAPID_SUBJECT=mailto:...`.

## Conector de Claude (MCP)

La imagen de la API (`railway/api/`) corre, además de la API oficial, el **servidor MCP oficial de
openGym** por HTTP. Así Claude (web y app del celular) puede leer tus rutinas, entrenamientos, peso,
1RM estimados y balance muscular. Es **solo lectura**: Claude no puede cambiar nada.

- URL del conector: `https://web-production-cddc0.up.railway.app/mcp/<MCP_SECRET>`
- `MCP_SECRET` es una variable del servicio **api** en Railway (Variables → `MCP_SECRET` → ver).
  **Quien tenga la URL completa puede leer tus datos:** no la compartas. Si se filtra, cambiá la
  variable (el servicio se redespliega solo) y actualizá el conector en Claude.
- Cualquier otra ruta bajo `/mcp/` responde 404. nginx no escribe esas URLs en los logs.
- Para agregarlo: claude.ai → Ajustes → Conectores → *Agregar conector personalizado* → pegá la URL.
  Después aparece también en la app del celular.

## Pasar a tu dominio propio (ej. `gym.tudominio.com`)

> ⚠️ Las passkeys quedan atadas al dominio. Al cambiarlo, las passkeys creadas en
> `*.up.railway.app` **dejan de servir** y hay que crear el perfil de nuevo. Antes de cambiarlo,
> exportá tus datos (Ajustes → **Exportar copia (JSON)**) para importarlos después.

1. Railway → proyecto **opengym** → servicio **web** → *Settings* → *Networking* → **Custom Domain**
   → escribí `gym.tudominio.com`, con **puerto 8080**.
2. Railway te muestra los registros DNS. Cargalos en tu proveedor **tal cual aparecen**:
   - **CNAME** — nombre `gym`, valor `algo.up.railway.app` (el que te muestre Railway).
   - Si también aparece un **TXT** de verificación, cargalo igual.
   - Si usás **Cloudflare**, dejá el registro en *DNS only* (nube gris), o poné SSL/TLS en *Full*.
3. Esperá a que Railway marque el dominio como verificado y con certificado (de minutos a horas).
4. En el servicio **api**, cambiá `RP_ID=gym.tudominio.com` y `ORIGIN=https://gym.tudominio.com`, y dejá que se redespliegue.
5. Verificá:
   - `https://gym.tudominio.com/api/health` responde `{"ok":true,...}`.
   - En los logs de `api` aparece `gym-api on :8080 (rpID=gym.tudominio.com, origin=https://gym.tudominio.com)`.

## Si falla la passkey ("verification failed")

1. Mirá los logs del servicio **api** en Railway: la línea `gym-api on :8080 (rpID=..., origin=...)`
   tiene que coincidir **exactamente** con la barra de direcciones de Safari.
2. `RP_ID` es solo el hostname (`gym.tudominio.com`); `ORIGIN` lleva `https://` y **no** lleva `/` al final.
3. `www.` o cualquier otro subdominio cuenta como otro sitio.
4. Si en los logs aparece `refused cross-origin ... expected=...`, `ORIGIN` no coincide con la URL que abriste.

## Backup de los datos

Todo lo importante está en el volumen `api-volume` (`/data`):

- `db.json` — usuarios y passkeys
- `state-<id>.json` — tus entrenamientos
- `secret` — clave de sesión
- `vapid.json` — claves de notificaciones
- `audit.log` — registro de actividad

**Opción A (la más simple, por usuario):** en la app, Ajustes → **Exportar copia (JSON)**. Guardá el
archivo en iCloud Drive o en otro lugar seguro.

**Opción B (todo el volumen, desde tu computadora):**

```bash
npm i -g @railway/cli
railway login                     # abre el navegador
railway link                      # elegí: lmtmlatam's Projects → opengym → production → api
railway volume files download / ./opengym-backup-$(date +%F)
```

> La opción B no se pudo probar desde el entorno donde se hizo el despliegue (el comando no
> llegaba a conectarse). Probala una vez y confirmá que la carpeta descargada tenga `db.json`.

Tratá el backup como algo privado: incluye passkeys (públicas) y la clave de sesión.

## Actualizar openGym

1. Mirá la última versión en https://github.com/DuarteSantos8/openGym/releases y leé el `CHANGELOG.md`.
2. Hacé un backup (ver arriba).
3. Cambiá `ARG OPENGYM_VERSION=X.Y.Z` en `railway/api/Dockerfile` **y** en `railway/web/Dockerfile`.
4. Desplegá los dos: desde `railway/api`, `railway up --service api`; desde `railway/web`,
   `railway up --service web`. Si conectás este repo a Railway (con *Root Directory* `railway/api`
   y `railway/web`), se despliegan solos con cada push.
5. Usá **la misma versión** en api y web, y verificá `/api/health`.
