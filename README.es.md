# BrowserSync

Un sistema de sincronización de marcadores/historial autoalojado (self-hosted) para
cualquier navegador basado en Chromium y para Firefox — una sola extensión Manifest V3,
construida para ambos, contra el mismo servidor. Está pensado para estos tipos de
personas:

- Cualquiera que use un fork de Chromium que no tiene Chrome Sync en absoluto, porque
  Google restringió esas APIs a builds oficiales de Chrome desde 2021 (ej.
  [Helium](https://github.com/imputnet/helium-chromium), ungoogled-chromium, y
  similares).
- Cualquiera que use Chrome, Brave, Edge, u otro navegador basado en Chromium que *sí*
  tiene su propia sincronización, pero que prefiere autoalojar sus propios datos de
  marcadores/historial en vez de confiárselos a los servidores de
  Google/Microsoft/Brave.
- Cualquiera que use Firefox junto a un navegador Chromium y quiera los mismos
  marcadores, historial y contraseñas en los dos, algo que la sincronización propia de
  ninguno de ellos permite.

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
curl http://localhost:3000/api/health   # debería devolver {"status":"ok","service":"browsersync","version":"…","apiVersion":1,"minApiVersion":1}
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

**Tamaño de subida:** los datos sincronizados se suben en una petición por tipo (el
historial suele ser el más grande), hasta `MAX_BLOB_BYTES` (5 MB por defecto). nginx
rechaza por defecto los cuerpos de más de 1 MB, y en la extensión eso se ve como una
sincronización fallida (HTTP 413), así que sube el límite en el bloque `server`:

```nginx
client_max_body_size 10m;
```

En Nginx Proxy Manager, pon esa línea en la pestaña **Advanced** del proxy host.

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
[`.github/workflows/publish-server.yml`](.github/workflows/publish-server.yml) construye
y publica una imagen multi-arquitectura (amd64 + arm64) en Docker Hub **solo cuando se
publica una versión del servidor** (ver [Publicar una nueva versión](#publicar-una-nueva-versión)),
o manualmente desde la pestaña Actions para volver a publicar una versión existente. Los
push a `main` y los pull requests nunca publican: el [CI](.github/workflows/ci.yml)
construye la imagen sin subirla, así un Dockerfile roto sigue fallando en el PR.

Para activarlo:

1. Crea un [token de acceso](https://hub.docker.com/settings/security) de Docker Hub
   (no la contraseña de tu cuenta) con **Read & Write**, para subir imágenes.
2. Opcionalmente, un segundo token con **Read, Write, Delete**, que Docker Hub exige
   solo para actualizar la pestaña "Overview" del repo.
3. En tu repo de GitHub, agrega estos secrets en **Settings → Secrets and variables →
   Actions**: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` y, si lo creaste,
   `DOCKERHUB_DESCRIPTION_TOKEN`.

Cada versión del servidor publica `axelromandev/browsersync-server` con los tags
`X.Y.Z`, `X.Y`, `latest` y el hash corto del commit, y sincroniza la pestaña "Overview"
de Docker Hub desde [`server/DOCKERHUB.md`](server/DOCKERHUB.md) — edita ese archivo (no
la interfaz web de Docker Hub) para cambiar la descripción que se muestra ahí.

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

### Publicar una nueva versión

Las versiones las gestiona [release-please](https://github.com/googleapis/release-please)
([`.github/workflows/release.yml`](.github/workflows/release.yml)). La extensión y el
servidor tienen versiones **separadas**: cada uno tiene su versión, su changelog
([`extension/CHANGELOG.md`](extension/CHANGELOG.md),
[`server/CHANGELOG.md`](server/CHANGELOG.md)) y sus tags (`extension-vX.Y.Z`,
`server-vX.Y.Z`), así un fix solo del servidor no sube la versión de la extensión en la
tienda. Las versiones hasta la 2.4.2 compartían número; su historial está en
[`CHANGELOG.md`](CHANGELOG.md).

Escribe los mensajes de commit (o los títulos de los PR, si fusionas con squash) como
[conventional commits](https://www.conventionalcommits.org/es/): `feat: ...` para
funciones nuevas, `fix: ...` para correcciones, `feat!: ...` para cambios incompatibles.
Un commit cuenta para la parte que toca, `extension/` o `server/`. En cada push a `main`,
release-please mantiene actualizado un único pull request de **release** que sube las
versiones (`extension/manifest.json`, `server/package.json`, `server/package-lock.json`)
y los changelogs. Fusiónalo cuando quieras publicar: crea los tags y las releases de
GitHub, publica la imagen del servidor si hubo versión del servidor, y adjunta los ZIP de
la extensión para Chromium y Firefox a la release de la extensión. No edites esas
versiones a mano. La publicación en Firefox es manual: sube
`browsersync-extension-firefox-X.Y.Z.zip` de esa release a
[AMO](https://addons.mozilla.org/developers/) como versión nueva, con sus notas.

Las dos builds salen de la misma carpeta `extension/`:
`node scripts/build-extension.mjs chrome|firefox` genera `dist/chrome/` o
`dist/firefox/` (la de Firefox solo cambia el manifest - ver el script). La propia
`extension/` se sigue pudiendo cargar sin empaquetar en Chromium tal cual.

Cada PR corre el [CI](.github/workflows/ci.yml), y `main` solo acepta el merge cuando
pasa su check `ci-ok`. [Dependabot](.github/dependabot.yml) abre PRs semanales para los
paquetes npm, la imagen base de Node (fijada por digest en `server/Dockerfile`) y las
GitHub Actions. La versión mayor de Node está en
[`server/.node-version`](server/.node-version), y el CI falla si el Dockerfile usa otra.

Configuración única — release-please corre como una GitHub App, porque los pull
requests y tags creados con el `GITHUB_TOKEN` por defecto no lanzan el CI:

1. Crea una GitHub App (**Settings → Developer settings → GitHub Apps → New GitHub
   App**) con los webhooks desactivados y estos permisos de repositorio: **Contents:
   Read and write**, **Pull requests: Read and write**. Instálala solo en este
   repositorio.
2. Genera una clave privada para ella.
3. En este repo, en **Settings → Secrets and variables → Actions**, agrega el Client ID
   de la App como **variable** `RELEASE_APP_CLIENT_ID` y la clave privada como
   **secret** `RELEASE_APP_PRIVATE_KEY`.

### Hacer un fork para tu propio servidor

Todo el sentido del campo "servidor self-hosted" en la extensión es que cualquiera
pueda apuntarla a su propia instancia. Si haces un fork de esta extensión para tu
propio uso:

1. Cambia `OFFICIAL_SERVER_URL` en `extension/config.js` a la URL de tu servidor.
2. Eso es todo — todo lo demás (íconos, nombre, etc.) es un cambio cosmético opcional.

### Distribuir la extensión a tus usuarios

No hay una publicación en la Chrome Web Store (esto no pasa por revisión de Google, y
en los forks sin Chrome Sync tampoco existe una alternativa oficial donde publicarla).
Tus usuarios de Chromium la cargan como "sin empaquetar" — ver la sección de usuarios
abajo. Los de Firefox la instalan desde AMO, porque Firefox solo ejecuta complementos
firmados por Mozilla (si haces un fork, necesitas tu propia ficha en AMO y tu propio ID
de complemento - `GECKO_ID` en [`scripts/build-extension.mjs`](scripts/build-extension.mjs)).
Comparte la carpeta `extension/` con ellos (un zip, una unidad de red compartida, un
release en tu repo, o un clon de git) junto con un enlace a [`PRIVACY.md`](PRIVACY.md)
(o [`PRIVACY.es.md`](PRIVACY.es.md)).

---

## Para usuarios

Estos pasos ponen a BrowserSync a funcionar en tu navegador para que tus marcadores
te sigan entre tus dispositivos. Funciona igual en cualquier navegador basado en
Chromium — Helium, ungoogled-chromium, Chrome, Brave, Edge, etc. — y en Firefox (140 o
más nuevo), todo con la misma cuenta.

### 1. Instalar la extensión

**Firefox:** instala BrowserSync desde [addons.mozilla.org](https://addons.mozilla.org/)
y pasa al paso 2.

**Navegadores basados en Chromium:**

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

1. La primera pantalla te pide la **URL del servidor** — todavía no existe un servidor
   oficial de BrowserSync, así que ingresa la que te haya dado quien administra tu
   servidor y haz clic en **Probar conexión**. El formulario de inicio de sesión /
   registro solo aparece cuando el servidor responde (puedes volver con **Cambiar**
   junto al nombre del servidor).
2. Ingresa tu **email**, elige una **contraseña** y haz clic en **Crear cuenta**.
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
- **Firefox y Chromium con la misma cuenta:** Firefox tiene una carpeta raíz más, el
  **Menú de marcadores**; en Chromium aparece como una carpeta "Menú de marcadores"
  dentro de "Otros marcadores", y lo que muevas ahí aparece en el menú de Firefox. Los
  separadores y las carpetas inteligentes de Firefox ("Más visitados", URLs `place:`)
  no se sincronizan: se quedan solo en ese Firefox.
- Si reinicias tu navegador, el popup te pedirá que vuelvas a ingresar tu
  **contraseña** una vez para reanudar la sincronización — tu sesión sigue intacta,
  esto solo vuelve a derivar la clave de cifrado local, que a propósito nunca se
  guarda en disco. Esto nunca requiere la passphrase de recuperación, salvo que la
  configuración local del dispositivo se pierda por alguna razón, en cuyo caso el
  popup te guiará para reconectarlo (contraseña + passphrase de nuevo).
- ¿Olvidaste tu contraseña? Haz clic en "¿Olvidaste tu contraseña?" en la pantalla de
  inicio de sesión y usa tu passphrase de recuperación para fijar una nueva.
- La sincronización de historial de navegación está desactivada por defecto.
  Actívala en el tab **Ajustes** del popup si la quieres, y define cuántos días de
  historial mantener sincronizados.
- Haz clic en **"Ver datos sincronizados"** en el popup para abrir una página que
  muestra exactamente qué hay guardado en el servidor para tu cuenta — tu árbol de
  marcadores, tu historial sincronizado (con buscador), y la última lista de
  extensiones instaladas que se sincronizó — descifrado localmente, ahí mismo en la
  página. Es una buena forma de confirmar que una sincronización realmente se hizo, o
  de ver qué tiene sincronizado otro de tus dispositivos sin tener que cambiar a él.
- Haz clic en **"Contraseñas guardadas"** en el popup para abrir tu bóveda de
  contraseñas: añade, edita, copia y genera contraseñas, o importa el CSV que exporta tu
  navegador (`chrome://password-manager/settings` → Exportar, o `about:logins` → ⋯ →
  Exportar en Firefox). Las contraseñas se cifran
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
- **Códigos de verificación (TOTP):** edita una contraseña guardada y pega la clave
  2FA o el enlace `otpauth://` que te da la web. La página de contraseñas muestra el
  código actual con su cuenta atrás, y el icono de llave ofrece rellenarlo en el campo
  del código de la web. Los CSV exportados de Bitwarden traen sus claves TOTP. Ten en
  cuenta que quien abra tu bóveda tendría entonces los dos factores.
- **Exportar / importar:** **Exportar CSV** en la página de contraseñas te da un
  archivo en texto plano para llevar tus contraseñas a otro gestor (bórralo después de
  importarlo). Para una copia segura, en los ajustes del popup → **"Exportar / importar
  copia de seguridad"** se descarga un archivo con tus contraseñas, los marcadores de
  este dispositivo y tus ajustes, cifrado con una contraseña de copia que tú eliges, y
  se puede restaurar en esta u otra cuenta. Las dos exportaciones piden antes tu
  contraseña de BrowserSync. El dashboard del servidor también puede exportar esos dos
  archivos desde su tarjeta Exportar (por ejemplo, desde un equipo sin la extensión); la
  restauración se hace solo desde la extensión.

### 4. Tus datos, y cómo borrarlos

Lee [`PRIVACY.md`](PRIVACY.md) (o [`PRIVACY.es.md`](PRIVACY.es.md)) — explica, en
lenguaje simple, exactamente qué se guarda, qué puede y no puede ver el
administrador, y cómo borrar permanentemente tu cuenta y todos tus datos
sincronizados cuando quieras (la página de tu cuenta en el servidor, en `/dashboard/` → "Eliminar mi cuenta",
enlazada desde popup → tab Ajustes → "Más ajustes" → "Abrir página de la cuenta").

### Perfil personal vs. de trabajo

Si usas perfiles separados del navegador para lo personal y lo laboral, instala la
extensión en cada perfil de forma independiente — cada uno mantiene su propia URL de
servidor, cuenta, y estado de sincronización, así que puedes apuntarlos a servidores
distintos o usar cuentas distintas sin que interfieran entre sí.

---

## Licencia

BrowserSync (la extensión y el servidor) se distribuye bajo la
[GNU Affero General Public License v3.0](LICENSE). Si ofreces a otras personas una
versión modificada del servidor, tienes que darles acceso a su código fuente.
