# BrowserSync

Un sistema de sincronización de marcadores/historial autoalojado (self-hosted) para
cualquier navegador basado en Chromium — las extensiones Manifest V3 funcionan igual
en todos ellos. Está pensado para dos tipos de personas:

- Cualquiera que use un fork de Chromium que no tiene Chrome Sync en absoluto, porque
  Google restringió esas APIs a builds oficiales de Chrome desde 2021 (ej.
  [Helium](https://github.com/imputnet/helium-chromium), ungoogled-chromium, y
  similares).
- Cualquiera que use Chrome, Brave, Edge, u otro navegador basado en Chromium que *sí*
  tiene su propia sincronización, pero que prefiere autoalojar sus propios datos de
  marcadores/historial en vez de confiárselos a los servidores de
  Google/Microsoft/Brave.

Dos partes:

- **`extension/`** — una extensión de navegador Manifest V3. Cifra tus datos en el
  cliente antes de que salgan de tu dispositivo.
- **`server/`** — un backend multiusuario autoalojado (Node.js + Express + PostgreSQL)
  que almacena y transmite blobs cifrados. Nunca ve tus datos en texto plano.

Ver [`PRIVACY.md`](PRIVACY.md) (o [`PRIVACY.es.md`](PRIVACY.es.md)) para saber qué se
guarda y qué no.

---

## Para el administrador

Esta es la parte que necesitas tú (quien administre el servidor). Las personas que
usen tu servidor solo necesitan la sección ["Para usuarios"](#para-usuarios) de abajo.

### Levantar el servidor

Requisitos: Docker y Docker Compose.

```bash
cd server
cp .env.example .env
```

Edita `.env`:
- Define `JWT_SECRET` con un valor aleatorio largo:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- Define `POSTGRES_PASSWORD` (usado por `docker-compose.yml`) con algo real —
  agrégalo a `.env` como `POSTGRES_PASSWORD=...`.
- Deja `ALLOW_REGISTRATION=true` mientras todavía se están creando cuentas.

Luego:

```bash
docker compose up -d --build
curl http://localhost:3000/api/health   # debería devolver {"status":"ok"}
```

Esto levanta Postgres y la API, y corre las migraciones de base de datos
automáticamente al iniciar (incluso en cada reinicio — las migraciones ya aplicadas se
omiten).

### Cerrar el registro

Una vez que todos los que necesitan una cuenta ya la tienen, detén los registros
nuevos sin tocar código:

```bash
# en .env
ALLOW_REGISTRATION=false
```

```bash
docker compose up -d
```

### Exponerlo fuera de tu homelab

La app por defecto solo escucha en `127.0.0.1:3000` en el host — no es alcanzable
desde tu red local ni desde internet hasta que pongas algo delante. Tres opciones,
más o menos de "menor esfuerzo" a "mayor control":

| Opción | Esfuerzo | Trade-offs |
|---|---|---|
| **Tailscale** | Bajo | Cada usuario instala Tailscale y se une a tu tailnet; la extensión apunta a la IP/hostname de Tailscale de tu máquina. Sin exposición pública alguna, pero cada dispositivo necesita Tailscale instalado y corriendo. |
| **Cloudflare Tunnel** | Medio | `cloudflared` en tu máquina del homelab expone la app en un subdominio público con TLS manejado por Cloudflare, sin necesidad de abrir puertos. Una URL pública implica la superficie de exposición/abuso normal de internet (mitigada por el rate limiting ya incluido), y dependes de la disponibilidad de Cloudflare. |
| **Nginx + Let's Encrypt** | Mayor | Control total, proxy inverso estándar con TLS en una conexión con puerto reenviado (port-forwarded). Tú te encargas de las renovaciones (certbot lo automatiza) y de endurecer Nginx tú mismo (fail2ban, etc.) ya que ahora estás directamente expuesto a internet. |

Elijas lo que elijas, pon el proxy inverso delante del puerto 3000 y dale a tus
usuarios la URL HTTPS resultante (ej. `https://sync.tudominio.com`) — eso es lo que
va en el campo "servidor self-hosted" de la extensión, y lo que deberías dejar fijo
como `OFFICIAL_SERVER_URL` en `extension/config.js` antes de distribuir la extensión.

### Backups

```bash
cd server
./scripts/backup.sh
```

Vuelca la base de datos (vía `pg_dump` dentro del contenedor `db` en ejecución) a
`server/backups/`, comprimido con gzip, y borra los backups con más de 14 días
(ambos configurables vía las variables de entorno `BROWSERSYNC_BACKUP_DIR` /
`BROWSERSYNC_BACKUP_RETENTION_DAYS`). Automatízalo con cron:

```bash
crontab -e
# agrega:
0 3 * * * cd /ruta/a/BrowserSync/server && ./scripts/backup.sh >> /var/log/browsersync-backup.log 2>&1
```

Completa tu horario/retención/ubicación real de backups en [`PRIVACY.md`](PRIVACY.md)
(o [`PRIVACY.es.md`](PRIVACY.es.md)) para que tus usuarios sepan qué esperar.

### Restaurar desde un backup

```bash
gunzip -c server/backups/browsersync_TIMESTAMP.sql.gz | docker compose exec -T db psql -U browsersync -d browsersync
```

### Publicar la imagen del servidor automáticamente (opcional)

Si prefieres descargar una imagen ya construida en tu homelab en vez de hacer
`git clone` y `docker compose up --build` ahí cada vez,
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)
construye y publica una imagen multi-arquitectura (amd64 + arm64) en Docker Hub cada
vez que cambia `server/` en `main`, en tags de versión (`v1.2.3`), o manualmente desde
la pestaña Actions. Los pull requests siguen construyendo la imagen (así un Dockerfile
roto falla el CI) pero nunca la publican.

Para activarlo:

1. Crea un [token de acceso](https://hub.docker.com/settings/security) de Docker Hub
   (no la contraseña de tu cuenta).
2. En tu repo de GitHub, agrega dos secrets en **Settings → Secrets and variables →
   Actions**: `DOCKERHUB_USERNAME` y `DOCKERHUB_TOKEN`.
3. Haz push a `main` (o ejecuta el workflow manualmente) — publica
   `axelromandev/browsersync-server` con el tag `latest`, el hash corto
   del commit, y cualquier tag semver que subas (ej. `v1.0.0` → `1.0.0`, `1.0`, `1`), y
   sincroniza la pestaña "Overview" del repo en Docker Hub desde
   [`server/DOCKERHUB.md`](server/DOCKERHUB.md) — edita ese archivo (no la interfaz web
   de Docker Hub) para cambiar la descripción que se muestra ahí.

Luego, en tu homelab, apunta el servicio `app` de `docker-compose.yml` a la imagen
publicada en vez de construirla localmente:

```yaml
app:
  image: axelromandev/browsersync-server:latest # en vez de "build: ."
```

```bash
docker compose pull && docker compose up -d
```

Considera fijar un tag específico (una versión o un hash de commit) en vez de
`latest` en producción, para que un push malo no se despliegue silenciosamente en tu
homelab en el siguiente `docker compose pull` — actualízalo deliberadamente cuando
estés listo.

### Hacer un fork para tu propio servidor

Todo el sentido del campo "servidor self-hosted" en la extensión es que cualquiera
pueda apuntarla a su propia instancia. Si haces un fork de esta extensión para tu
propio uso:

1. Cambia `OFFICIAL_SERVER_URL` en `extension/config.js` a la URL de tu servidor.
2. Eso es todo — todo lo demás (íconos, nombre, etc.) es un cambio cosmético opcional.

### Distribuir la extensión a tus usuarios

No hay una publicación en la Chrome Web Store (esto no pasa por revisión de Google, y
en los forks sin Chrome Sync tampoco existe una alternativa oficial donde publicarla).
Tus usuarios la cargan como "sin empaquetar" — ver la sección de usuarios abajo.
Comparte la carpeta `extension/` con ellos (un zip, una unidad de red compartida, un
release en tu repo, o un clon de git) junto con un enlace a [`PRIVACY.md`](PRIVACY.md)
(o [`PRIVACY.es.md`](PRIVACY.es.md)).

---

## Para usuarios

Estos pasos ponen a BrowserSync a funcionar en tu navegador para que tus marcadores
te sigan entre tus dispositivos. Funciona igual en cualquier navegador basado en
Chromium — Helium, ungoogled-chromium, Chrome, Brave, Edge, etc.

### 1. Instalar la extensión

1. Consigue la carpeta `extension` de quien haya configurado el servidor que vas a
   usar (o de este repositorio, si lo estás configurando tú mismo).
2. Abre tu navegador y ve a `chrome://extensions` (la misma dirección en cualquier
   navegador basado en Chromium).
3. Activa el **Modo de desarrollador** (interruptor arriba a la derecha).
4. Haz clic en **Cargar sin empaquetar** ("Load unpacked") y selecciona la carpeta
   `extension`.
5. Aparece un ícono de "BrowserSync" en tu barra de herramientas, y se abre una nueva
   pestaña pidiéndote que te conectes.

### 2. Crear tu cuenta

En la pestaña que se abrió (o en cualquier momento después, haciendo clic en el
ícono de la barra de herramientas):

1. Ingresa tu **email** y elige una **contraseña**. Todavía no existe un servidor
   oficial de BrowserSync, así que la pantalla también te pide la **URL del
   servidor** — ingresa la que te haya dado quien administra tu servidor, y haz clic
   en **Probar conexión** (el botón "Crear cuenta" queda deshabilitado hasta que
   funcione). Si en el futuro esta extensión trae un servidor por defecto, este paso
   se vuelve opcional.
2. Haz clic en **Crear cuenta**.
3. Justo después, BrowserSync te muestra una **passphrase de recuperación** generada
   para ti. **Guárdala en un lugar seguro ahora mismo** — un gestor de contraseñas
   como Bitwarden, 1Password, o KeePass. Esta passphrase es la única forma de conectar
   un segundo dispositivo o de restablecer tu contraseña si la olvidas. Nunca se envía
   de una forma que le permita al servidor (o a su administrador) leer tus datos — eso
   es justo lo que mantiene tus marcadores privados. No existe una opción de
   "olvidé mi passphrase": si pierdes tanto tu contraseña como esta passphrase, nadie
   puede recuperar tus datos sincronizados.
4. Marca la casilla de confirmación y haz clic en **Continuar**.

### 3. Usarlo en el día a día

- BrowserSync sincroniza automáticamente en segundo plano (cada 15 minutos por
  defecto).
- Haz clic en el ícono de la barra de herramientas en cualquier momento para ver el
  estado de tu última sincronización, o presiona **Sincronizar ahora** para una
  sincronización inmediata.
- Para sincronizar marcadores en un segundo dispositivo: instala la extensión ahí,
  ingresa la **misma URL del servidor** y prueba la conexión, elige **"¿Ya tienes una
  cuenta? Inicia sesión"**, e ingresa el mismo email y contraseña. Como es un
  dispositivo nuevo, te pedirá tu **passphrase de recuperación una vez** para terminar
  de conectarlo — después de eso, tu contraseña sola
  desbloquea BrowserSync en ese dispositivo.
- Si reinicias tu navegador, el popup te pedirá que vuelvas a ingresar tu
  **contraseña** una vez para reanudar la sincronización — tu sesión sigue intacta,
  esto solo vuelve a derivar la clave de cifrado local, que a propósito nunca se
  guarda en disco. Esto nunca requiere la passphrase de recuperación, salvo que la
  configuración local del dispositivo se pierda por alguna razón, en cuyo caso el
  popup te guiará para reconectarlo (contraseña + passphrase de nuevo).
- ¿Olvidaste tu contraseña? Haz clic en "¿Olvidaste tu contraseña?" en la pantalla de
  inicio de sesión y usa tu passphrase de recuperación para fijar una nueva.
- La sincronización de historial de navegación está desactivada por defecto.
  Actívala en la configuración del popup (⚙) si la quieres, y define cuántos días de
  historial mantener sincronizados.
- Haz clic en **"Ver datos sincronizados"** en el popup para abrir una página que
  muestra exactamente qué hay guardado en el servidor para tu cuenta — tu árbol de
  marcadores, tu historial sincronizado (con buscador), y la última lista de
  extensiones instaladas que se sincronizó — descifrado localmente, ahí mismo en la
  página. Es una buena forma de confirmar que una sincronización realmente se hizo, o
  de ver qué tiene sincronizado otro de tus dispositivos sin tener que cambiar a él.
- Haz clic en **"Contraseñas guardadas"** en el popup para abrir tu bóveda de
  contraseñas: añade, edita, copia y genera contraseñas, o importa el CSV que exporta tu
  navegador (`chrome://password-manager/settings` → Exportar). Las contraseñas se cifran
  con la misma clave de datos que todo lo demás y se sincronizan con tus otros
  dispositivos; el servidor no puede leerlas. Borra el CSV exportado después de
  importarlo: está en texto plano.
  Activa **"Sugerir y guardar contraseñas en páginas web"** arriba en esa página (pide
  permiso para acceder a las páginas web) para tener un icono de llave en los campos de
  contraseña con tus cuentas guardadas para ese sitio, y un aviso de "¿Guardar
  contraseña?" al iniciar sesión en un sitio nuevo. Nada se rellena sin tu clic. Por
  defecto, una contraseña guardada en `example.com` también se ofrece en sus subdominios
  (`login.example.com`); puedes cambiarlo a host, "empieza por" o URL exacta, en general
  o para cada contraseña.
  Nota: cerrar sesión elimina la copia de la bóveda de este dispositivo (vuelve desde el
  servidor en el siguiente inicio de sesión), así que el popup te avisa si hay cambios
  sin sincronizar.

### 4. Tus datos, y cómo borrarlos

Lee [`PRIVACY.md`](PRIVACY.md) (o [`PRIVACY.es.md`](PRIVACY.es.md)) — explica, en
lenguaje simple, exactamente qué se guarda, qué puede y no puede ver el
administrador, y cómo borrar permanentemente tu cuenta y todos tus datos
sincronizados cuando quieras (popup → ⚙ → "Eliminar cuenta y todos los datos
sincronizados").

### Perfil personal vs. de trabajo

Si usas perfiles separados del navegador para lo personal y lo laboral, instala la
extensión en cada perfil de forma independiente — cada uno mantiene su propia URL de
servidor, cuenta, y estado de sincronización, así que puedes apuntarlos a servidores
distintos o usar cuentas distintas sin que interfieran entre sí.
