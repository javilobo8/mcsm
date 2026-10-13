# MC Server Manager

Panel self-hosted para gestionar servidores de Minecraft (imagen `itzg/minecraft-server`) repartidos en varias máquinas con Docker. Un panel, un agente por máquina.

## Despliegue

Un **panel** (web y API, puerto 8080) y un **agente** en cada máquina que vaya a tener servidores; la máquina del panel suele llevar también el suyo. Las imágenes se publican en GitHub Container Registry con cada [versión](https://github.com/javilobo8/mcsm/releases):

| Imagen | Qué es |
|---|---|
| `ghcr.io/javilobo8/mcsm-panel` | Panel: web y API (puerto 8080) |
| `ghcr.io/javilobo8/mcsm-agent` | Agente de nodo: gestiona los servidores con el Docker de su máquina |

Las dos para `linux/amd64` y `linux/arm64` (p. ej. una Raspberry Pi 4/5 con sistema de 64 bits), con los tags `X.Y.Z`, `X.Y` y `latest`. Usa **la misma versión** en el panel y en todos los agentes.

**Cada máquina necesita** Linux con Docker Engine y el plugin Compose v2 (`docker compose`), salida a Internet (imágenes y descargas de Minecraft) y un directorio para los mundos (`DATA_ROOT`, ruta absoluta; por defecto `/srv/minecraft`). Abre los puertos de [Puertos y cortafuegos](#puertos-y-cortafuegos).

Los comandos `docker compose` de este README se ejecutan en el directorio del `docker-compose.yml` y su `.env`. Si usas el repositorio clonado, los mismos ficheros están en `deploy/`: añade `-f deploy/docker-compose.yml --env-file deploy/.env` (en un nodo, `-f deploy/docker-compose.node.yml --env-file deploy/.env`).

### Máquina principal (panel + agente)

En un directorio (p. ej. `/opt/mcsm`) crea un `docker-compose.yml` y un `.env`. Puedes descargarlos del repositorio:

```bash
mkdir -p /opt/mcsm && cd /opt/mcsm
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/.env.example
```

`docker-compose.yml` (igual que `deploy/docker-compose.yml`):

```yaml
# Requiere la red compartida: docker network create mcsm
# Imágenes publicadas en GHCR; MCSM_VERSION (en .env) fija la versión, vacío = latest. Para construir desde el
# código, añade -f deploy/docker-compose.build.yml.
name: mcsm
services:
  panel:
    image: ghcr.io/javilobo8/mcsm-panel:${MCSM_VERSION:-latest}
    init: true
    restart: unless-stopped
    ports: ["8080:8080"]
    environment:
      # Vacío: el panel usa la dirección con la que lo abres en el navegador (Host con puerto).
      PANEL_PUBLIC_URL: ${PANEL_PUBLIC_URL:-}
      # Opcional: token de configuración inicial (vacío = el panel genera uno y lo escribe en su log).
      PANEL_SETUP_TOKEN: ${PANEL_SETUP_TOKEN:-}
    volumes:
      - panel-data:/data
  agent:
    image: ghcr.io/javilobo8/mcsm-agent:${MCSM_VERSION:-latest}
    # docker stop mata a los 10 s; al pararlo, el agente espera a la vez, hasta 25 s, a sus
    # operaciones de archivos y a las copias en curso (save-on) antes de salir.
    stop_grace_period: 30s
    restart: unless-stopped
    depends_on: [panel]
    environment:
      PANEL_URL: http://panel:8080
      ENROLL_TOKEN: ${ENROLL_TOKEN:-}
      NODE_NAME: ${NODE_NAME:-principal}
      DATA_ROOT: ${DATA_ROOT:-/srv/minecraft}
      # Opcional: tamaño máximo de una subida de archivo, en bytes (vacío = 4 GiB).
      UPLOAD_MAX_BYTES: ${UPLOAD_MAX_BYTES:-}
      HOST_PROC: /host/proc
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT:-/srv/minecraft}:${DATA_ROOT:-/srv/minecraft}
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    networks: [default, mcsm]
networks:
  mcsm:
    name: mcsm
    external: true
volumes:
  panel-data: {}
  agent-data: {}
```

`.env` (edítalo; el resto de variables de `deploy/.env.example` son opcionales):

```bash
# Versión de las imágenes: fíjala para que actualizar sea siempre un paso consciente (vacío = latest)
MCSM_VERSION=0.9.0
# Dirección del panel con el puerto, tal como la ven los otros nodos y tu navegador
# (vacío = la dirección con la que abras el panel en el navegador)
PANEL_PUBLIC_URL=http://192.168.1.10:8080
# Directorio del host (ruta ABSOLUTA) para los mundos de esta máquina
DATA_ROOT=/srv/minecraft
# Token de alta del agente local: se rellena en el paso 4
ENROLL_TOKEN=
```

Después:

1. Crea la red compartida por el agente y los servidores, y el directorio de datos: `docker network create mcsm 2>/dev/null || true` y `sudo mkdir -p /srv/minecraft` (tu `DATA_ROOT`).
2. Arranca **solo el panel**: `docker compose up -d panel`.
3. Busca en su log el token de configuración inicial (`docker compose logs panel | grep "Token de configuración inicial"`), abre `http://<ip>:8080` y crea la contraseña (mínimo 8 caracteres) con ese token. También puedes fijarlo antes con `PANEL_SETUP_TOKEN` en el `.env`. Así se cierra la ventana del «primer visitante»: una web de Internet no puede fijar la contraseña por DNS rebinding.
4. En **Nodos → Añadir nodo**, pon en «Directorio de datos» el mismo `DATA_ROOT` del `.env` y copia el token en `ENROLL_TOKEN`. El token caduca a los 15 minutos y sirve una sola vez.
5. Arranca el agente: `docker compose up -d agent`. El nodo aparece como conectado. Este agente llega al panel por la red interna del compose (`http://panel:8080`). El alta queda guardada en el volumen `mcsm_agent-data`: a partir de ahí `ENROLL_TOKEN` se ignora.

No arranques el agente sin token (un `docker compose up -d` sin nombrar servicio lo haría): sin alta guardada ni token, sale con error y Docker lo reinicia en bucle.

### Otras máquinas (solo agente)

En cada una, crea la red (`docker network create mcsm 2>/dev/null || true`) y el `DATA_ROOT`. Luego, en **Nodos → Añadir nodo**, genera un token con el «Directorio de datos» de esa máquina y, antes de 15 minutos, arranca el agente de una de estas dos formas.

**Con `docker run`:** ejecuta el comando que muestra el panel. Ya lleva tu token, tu dirección y la imagen del agente de la misma versión que el panel; es así:

```bash
docker network create mcsm 2>/dev/null || true
docker run -d --name mcsm-agent --restart unless-stopped --stop-timeout 30 \
  --network mcsm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/minecraft:/srv/minecraft \
  -v mcsm-agent-data:/var/lib/mcsm-agent \
  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \
  -e PANEL_URL=http://192.168.1.10:8080 \
  -e ENROLL_TOKEN=<token-de-alta> \
  -e DATA_ROOT=/srv/minecraft \
  ghcr.io/javilobo8/mcsm-agent:0.9.0
```

**Con Docker Compose:** en un directorio (p. ej. `/opt/mcsm-node`), un `docker-compose.yml` igual que `deploy/docker-compose.node.yml` (`curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/javilobo8/mcsm/main/deploy/docker-compose.node.yml`):

```yaml
# Requiere la red compartida: docker network create mcsm
# Imagen publicada en GHCR; MCSM_VERSION (en .env) fija la versión, vacío = latest. Con un agente construido desde el
# código (docker build -t mcsm-agent:latest agent/), pon MCSM_AGENT_IMAGE=mcsm-agent:latest.
name: mcsm-node
services:
  agent:
    image: ${MCSM_AGENT_IMAGE:-ghcr.io/javilobo8/mcsm-agent:${MCSM_VERSION:-latest}}
    # docker stop mata a los 10 s; al pararlo, el agente espera a la vez, hasta 25 s, a sus
    # operaciones de archivos y a las copias en curso (save-on) antes de salir.
    stop_grace_period: 30s
    restart: unless-stopped
    environment:
      PANEL_URL: ${PANEL_URL:?Define PANEL_URL, p. ej. http://192.168.1.10:8080}
      ENROLL_TOKEN: ${ENROLL_TOKEN:-}
      # Opcional: vacío = el panel usa el nombre del token de alta (igual que el docker run de la UI, que no lo pasa).
      NODE_NAME: ${NODE_NAME:-}
      DATA_ROOT: ${DATA_ROOT:-/srv/minecraft}
      # Opcional: tamaño máximo de una subida de archivo, en bytes (vacío = 4 GiB).
      UPLOAD_MAX_BYTES: ${UPLOAD_MAX_BYTES:-}
      HOST_PROC: /host/proc
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT:-/srv/minecraft}:${DATA_ROOT:-/srv/minecraft}
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    networks: [mcsm]
networks:
  mcsm:
    name: mcsm
    external: true
volumes:
  agent-data: {}
```

y su `.env`:

```bash
MCSM_VERSION=0.9.0
PANEL_URL=http://192.168.1.10:8080
ENROLL_TOKEN=<token-de-alta>
DATA_ROOT=/srv/minecraft
```

Después, `docker compose up -d`. Sin `NODE_NAME`, el nodo toma el nombre del token.

`DATA_ROOT` se monta en el agente **con la misma ruta dentro y fuera** (`-v /srv/minecraft:/srv/minecraft`): el agente lo comprueba al arrancar y no arranca si no está montado desde el host.

### Construir desde el código

En vez de descargar las imágenes, con el repositorio clonado: añade `-f deploy/docker-compose.build.yml` a cada `docker compose` y `--build` a los `up` (p. ej. `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml --env-file deploy/.env up -d --build panel`). Las imágenes se llaman entonces `mcsm-panel:latest` y `mcsm-agent:latest`, y el `docker run` de **Añadir nodo** usa `mcsm-agent:latest`, que tendrás que construir en cada nodo (`docker build -t mcsm-agent:latest agent/`; con el compose de nodo, `MCSM_AGENT_IMAGE=mcsm-agent:latest` en su `.env`).

### Rotar el token de un nodo

**Nodos →** detalle del nodo **→ Rotar token.** El agente tiene que estar conectado. El token viejo sigue valiendo hasta que el agente se reconecta con el nuevo; si no lo confirma, el panel espera 2 min antes de reintentar. Los agentes anteriores al Plan 9 no admiten la rotación: actualízalos primero.

Si sospechas que el token de un nodo se ha filtrado, rotarlo no basta: borra el nodo y vuelve a darlo de alta.

## Ajustes

- **Contraseña.** Al cambiarla se cierran todas las sesiones, también las de otros navegadores.
- **URL del panel.** La guardada manda sobre `PANEL_PUBLIC_URL`; es la del comando de alta de nodos y el `Origin` que acepta el WebSocket. Las escrituras (`POST`/`PUT`/`PATCH`/`DELETE` bajo `/api/`) con un `Origin` que no sea el del panel dan 403, y el login también es una escritura. Detrás de un proxy inverso que reescriba `Host`, el login por el proxy da 403: entra directamente por `http://<ip>:8080` y guarda aquí la dirección con la que entras por el proxy, fija `PANEL_PUBLIC_URL` en el `.env` del compose (solo cuenta si no hay una guardada aquí) o haz que el proxy conserve `Host` (en nginx, `proxy_set_header Host $http_host;`).
- **Rango de puertos de juego.** Solo se usa para servidores nuevos sin puerto.
- **API key de CurseForge.** Si la guardada no es válida, la página lo avisa.
- **Versiones y builds.** Al crear o editar un servidor, el panel consulta por HTTPS las fuentes oficiales (`piston-meta.mojang.com`, `fill.papermc.io`, `api.purpurmc.org`, `hub.spigotmc.org`, `meta.fabricmc.net`, `meta.quiltmc.org`, `files.minecraftforge.net`, `maven.neoforged.net`) para listar versiones de Minecraft y builds; las listas se guardan en memoria (1 h las versiones, 15 min los builds). Sin salida a Internet desde el panel la versión se puede escribir a mano. El campo **Build / loader** (Paper, Folia, Purpur, Fabric, Quilt, Forge, NeoForge) fija el build o la versión del loader; vacío = el último al arrancar.

## Puertos y cortafuegos

| Máquina | Abre (entrada) | Para qué |
|---|---|---|
| Panel | `8080/tcp` desde la LAN | La web y los agentes de las otras máquinas (HTTP y WebSocket). No lo abras a Internet. |
| Cada nodo | El puerto de juego de cada servidor (`tcp`; el panel los reparte desde el 25565 hasta el 25600), sus puertos extra (p. ej. `19132/udp` de Geyser) y el del router si lo activas | Los jugadores |

- El agente no escucha en ningún puerto: solo **sale** hacia `PANEL_URL` (el 8080 del panel). RCON (25575) va por la red Docker `mcsm` y no se publica.
- Los nodos necesitan salida a Internet: las imágenes de Docker Hub y las descargas de itzg (Paper, mods, modpacks).
- Para jugar desde fuera de casa, redirige en el router de casa el puerto del servidor (o el del mc-router) a la IP del nodo. El 8080, nunca.
- **El 25565.** El primer servidor de cada nodo se queda el 25565 (el primer puerto libre), que es también el puerto por defecto del mc-router. Si vas a usar el router, actívalo antes de crear servidores en ese nodo. Si ya hay un servidor en el 25565, activarlo falla con «El puerto 25565 lo usa el servidor «…» de este nodo»: pon otro puerto al router o cambia el del servidor (Configuración → Red). Si otro programa de la máquina ya ocupa el puerto (p. ej. un servidor de Minecraft que no gestiona el panel), el servidor no arranca y su cabecera muestra el error de Docker: cámbiale el puerto.

## Actualizar

**Primero los agentes y luego el panel.** Un agente antiguo rechaza lo que no conoce, pero un panel nuevo puede pedirle cosas que todavía no sabe hacer. Usa la misma versión en todas las máquinas: en cada `.env`, `MCSM_VERSION=<nueva>` (con `latest`, basta con volver a descargar). Las notas de cada versión están en las [Releases](https://github.com/javilobo8/mcsm/releases).

1. Agentes.
   - En la máquina principal: `docker compose pull agent && docker compose up -d --no-deps agent` (`--no-deps`: sin él, Compose también reiniciaría el panel).
   - En los nodos con compose: `docker compose pull && docker compose up -d`.
   - En los nodos con `docker run`: `docker pull ghcr.io/javilobo8/mcsm-agent:<nueva>`, luego `docker stop mcsm-agent && docker rm mcsm-agent` (con `stop` tiene sus 30 s para terminar; `rm -f` lo mata en el acto) y vuelve a lanzar el mismo `docker run` cambiando la versión de la imagen. El volumen `mcsm-agent-data` conserva el alta, así que el `ENROLL_TOKEN` caducado da igual.
2. Panel: `docker compose pull panel && docker compose up -d --no-deps panel`.

[Construyendo desde el código](#construir-desde-el-código): `git pull` en cada máquina y los mismos pasos con `-f deploy/docker-compose.build.yml` y `up -d --build` en vez de `pull` (en los nodos con `docker run`, `docker build -t mcsm-agent:latest agent/`).

El agente muestra su versión (`agent/VERSION`) en **Nodos**. Las imágenes base (Node, `docker:dind`, Playwright…) van fijadas por digest; para subirlas de versión, consulta el nuevo con `docker buildx imagetools inspect <imagen>:<tag>` y cambia tag y digest a la vez.

**Router.** Tras actualizar el agente, el contenedor de mc-router se recrea una vez (ahora monta el directorio del socket filtrado del agente en vez del socket de Docker). Reiniciar o actualizar el agente después no lo reinicia: mc-router se vuelve a conectar solo al socket nuevo (en menos de 30 s), y mientras tanto sigue enrutando a los servidores que ya conocía.

Los servidores de Minecraft siguen en marcha mientras se actualizan el agente y el panel. Algunas actualizaciones del agente cambian cómo construye los contenedores y los recrean (cada servidor se reinicia) al volver a arrancar.

## Copia de la base de datos del panel

Todo lo del panel (servidores, nodos, plantillas, historial, contraseña) está en `panel.db`, en el volumen `mcsm_panel-data`. Los mundos y sus copias no: están en el `DATA_ROOT` de cada nodo. Cópiala con el panel parado: los servidores siguen funcionando, pero espera a que no haya copias, restauraciones ni migraciones en curso. Copia el volumen entero: el panel usa WAL y los ficheros `panel.db-wal` y `panel.db-shm` forman parte de la base de datos.

```bash
docker compose stop panel
docker run --rm -v mcsm_panel-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/mcsm-panel-$(date +%F).tgz -C /data .
docker compose start panel
```

Guárdala en un sitio privado: contiene las contraseñas RCON de los servidores y el secreto de las sesiones. Para restaurarla, con el panel parado:

```bash
docker run --rm -v mcsm_panel-data:/data -v "$PWD":/backup alpine sh -c 'rm -f /data/panel.db* && tar xzf /backup/mcsm-panel-<fecha>.tgz -C /data'
```

Antes, lee el aviso de [Migración entre nodos](#migración-entre-nodos) sobre restaurar una copia anterior a una migración.

## Archivos

La pestaña **Archivos** de cada servidor navega por su carpeta `data`, edita ficheros de texto (hasta 2 MiB) y sube y descarga ficheros. Las subidas y descargas van en streaming navegador ↔ panel ↔ agente, sin pasar por el disco del panel.

Configuración del agente (por nodo, variable de entorno):

| Variable | Por defecto | Qué hace |
|---|---|---|
| `UPLOAD_MAX_BYTES` | `4294967296` (4 GiB) | Tamaño máximo de una subida, en bytes. Por encima, el nodo la rechaza con «la subida supera el máximo… (UPLOAD_MAX_BYTES)». Ejemplo para 10 GiB: `UPLOAD_MAX_BYTES=10737418240`. |

Se fija en el `.env` del compose, el principal o el de nodo (vacío = el valor por defecto) o, en un nodo arrancado con el `docker run` de **Añadir nodo**, añadiendo `-e UPLOAD_MAX_BYTES=…`.

Límites fijos, para saber qué esperar:

- Como mucho **4 subidas o descargas a la vez por nodo**; la quinta recibe «el nodo ya tiene 4 transferencias de archivos en curso».
- Una transferencia se corta si pasa **60 s sin moverse un byte** (el agente) o 120 s (el panel); mientras avance, no tiene plazo total.
- Las escrituras son atómicas: un temporal oculto `.mcsm-tmp-<16 hexadecimales>` en la misma carpeta y un `rename` al terminar. Si el agente muere a mitad (corte de luz, `kill -9`), el temporal se borra al volver a arrancar (si lleva más de 1 h sin tocarse). Un fichero tuyo que solo empiece igual (`.mcsm-tmp-notas`) es un fichero más.
- Al pararlo (`docker stop`, actualización), el agente espera hasta 20 s a que las operaciones de archivos en curso terminen o limpien, a la vez que a las copias (ver [Parar el agente](#parar-el-agente)).
- Mientras el servidor tiene una copia o una restauración en curso (o en cola), o está bloqueado sin datos, Archivos solo deja mirar y descargar: escribir, crear carpetas, renombrar, borrar y subir responden «servidor ocupado o reservado (…)». Ver [Copias de seguridad](#copias-de-seguridad).

## Copias de seguridad

La pestaña **Backups** de cada servidor hace copias al momento, programa copias automáticas (cron con la hora del nodo, retención por número y por días, y «solo si ha entrado alguien desde la última») y restaura. **Historial** muestra los trabajos con su registro.

- **Dónde:** `DATA_ROOT/<slug>/backups/<slug>-<fecha>-<versión de la spec>.tar.zst` (tar + zstd), con un `.json` al lado (sha256, tamaño). Con el servidor en marcha la copia es en caliente (`save-off`, `save-all flush`, copia, `save-on`, que se envía aunque la copia falle); parado, directa. Los temporales de las subidas de Archivos nunca entran.
- **Retención:** solo poda las copias programadas, y nunca la más reciente. Las manuales y los datos pre-restore se borran a mano.
- **Descargar una copia:** desde la pestaña Backups; el fichero pasa por el panel en streaming. Los datos pre-restore no se descargan.
- **`save-on` fallido:** si tras una copia en caliente no se pudo reactivar el guardado automático, el agente lo reintenta solo, con una espera que empieza en 30 s y se duplica en cada fallo hasta 5 min, y lo registra como evento «Guardado automático desactivado».
- **Las plantillas se llevan la programación.** «Guardar como plantilla» la incluye y cada servidor creado con la plantilla la hereda; el editor de plantillas y el asistente la enseñan, pero se cambia en la pestaña Backups de cada servidor.

### Restaurar y los datos pre-restore

Restaurar **no borra nada**: para el servidor, extrae la copia en `data.restoring-<fecha>`, aparta los datos actuales en `DATA_ROOT/<slug>/data.pre-restore-<fecha>` y pone la copia en `data`. Después lo vuelve a arrancar si su estado deseado es «en marcha»; si no, se queda parado. Si el agente cae justo al final de una restauración, el trabajo puede quedar «interrumpido» con los datos ya restaurados: comprueba el mundo antes de repetirla.

El pre-restore aparece en la lista de copias. No se restaura desde la web: bórralo cuando ya no lo necesites (es un mundo entero, así que puede tardar). Para volver a esos datos a mano, para el servidor desde el panel y, en el host del nodo:

```bash
cd "$DATA_ROOT/<slug>"
mv data data.descartado                   # o bórralo, si no lo quieres
mv data.pre-restore-<fecha> data
rm -f data.pre-restore-<fecha>.json
```

Luego arráncalo desde el panel y borra `data.descartado` cuando lo hayas comprobado.

### Servidor bloqueado sin `data`

Si una restauración falla justo en el intercambio, o el agente muere a mitad y al volver no está claro cuáles son los datos buenos, el servidor se queda **parado y reservado**, con el error en la cabecera: «…El servidor no se arrancará hasta que exista …/data». Arrancarlo sin `data` crearía una carpeta vacía y el servidor generaría un mundo nuevo. Mientras dure, encender y apagar dan 409 y Archivos solo permite leer.

Para recuperarlo, en el host del nodo, deja un `data` en su sitio:

- **Volver a los datos que había:** `mv data.pre-restore-<fecha> data` dentro de `DATA_ROOT/<slug>`. Los que no tienen `.json` al lado son intercambios que no terminaron, es decir, los datos originales; si hay varios, normalmente es el más reciente.
- **Empezar un mundo nuevo:** `mkdir data && chown 1000:1000 data`.

El agente lo revisa cada 15 s: en cuanto hay `data`, libera el servidor y lo devuelve a su estado deseado (lo arranca si debía estar en marcha).

### Espacio, archivos y trabajos a la vez

- **Margen de espacio:** una copia estima lo que ocupará (la última copia más un 20 % o, la primera vez, lo que ocupan los datos) y una restauración lo que ocupa extraída. Si en el disco no queda eso más un margen de 256 MiB o el 5 % (el mayor), no empiezan. Durante la escritura vigilan el margen y, si se agota, se cortan: se borra lo escrito a medias y los datos del servidor no se tocan.
- **Archivos da «ocupado» durante copias y restauraciones** (y con el servidor bloqueado sin datos): solo se puede mirar y descargar. Una restauración espera hasta 10 s a que terminen las operaciones de archivos ya empezadas; si siguen, falla con «servidor ocupado o reservado: hay operaciones de archivos en curso…» sin tocar nada.
- **Como mucho 2 copias o restauraciones a la vez por nodo.** Las demás esperan «En cola…», con su servidor reservado (encender, apagar y modificar archivos dan ocupado hasta que terminen).

### Parar el agente

Al parar el agente (`docker stop`, actualizarlo), espera **a la vez** hasta 20 s a las operaciones de archivos y hasta 25 s a las copias y restauraciones en curso: una copia en caliente se cancela y envía su `save-on`. Docker lo mataría a los 10 s, así que los compose le dan `stop_grace_period: 30s` y el `docker run` de **Añadir nodo** lleva `--stop-timeout 30`. Si arrancas el agente de otra forma, dale al menos 30 s. Si aun así muere a mitad, al volver a arrancar borra los restos (copias `.partial`, `data.restoring-*`) y, si una restauración se quedó a medias, devuelve los datos originales a `data` o bloquea el servidor (ver arriba).

## Eventos y bucles de crash

La página **Eventos** y el **Historial** de cada servidor registran: cierre con error, falta de memoria, bucle de crash, contenedor recreado, guardado automático desactivado/reactivado y token rotado. Se conservan 30 días o 10 000 eventos. Si el panel estaba desconectado, el evento puede perderse, pero el error se sigue viendo en la cabecera del servidor.

**Bucle de crash:** más de 3 cierres con error en una hora y el agente para el servidor y no lo vuelve a arrancar (ni Docker, ni el panel al reconectar, ni mc-router) hasta que pulses **Arrancar** o guardes una configuración nueva. El panel lo deja en «parado».

## Importar servidores existentes

**Nodos → Importar** (o el detalle de un nodo) detecta los contenedores `itzg/minecraft-server` de esa máquina que el panel aún no gestiona. Los revisas antes de adoptarlos.

- **Adoptar** no para nada: el contenedor original sigue hasta el primer **Guardar y aplicar**, que lo recrea con las etiquetas `mcsm.*` y la misma carpeta de datos. **Adoptar y aplicar** lo hace de una vez.
- **Datos fuera de `DATA_ROOT`** (`dataPath`): sin copias ni archivos, y no se migran.
- **Contenedores de Docker Compose:** quita el servicio del compose tras el primer «Guardar y aplicar», o Compose lo volverá a crear.
- **Dejar de usar una carpeta externa:** no hay botón (el agente no ve carpetas fuera de `DATA_ROOT`). Elimina el servidor sin borrar datos, mueve la carpeta a `DATA_ROOT/<slug>/data` y vuelve a importarlo.

## Migración entre nodos

La pestaña **Migrar** de cada servidor lo mueve (mundo, configuración, copias e historial) a otro nodo con un trabajo de 7 pasos visibles:

1. parar en el origen;
2. copia previa (`pre_migration`);
3. subirla al panel, comprobando tamaño y sha256;
4. enviarla al destino, que la vuelve a comprobar y la restaura;
5. crear allí el servidor (versión de la spec +1 y, si el suyo choca, otro puerto);
6. arrancarlo y esperar a que quede sano (como mucho 5 min). Si estaba parado, se vuelve a parar;
7. confirmar el cambio de nodo y retirar el origen.

**Datos y copias.**
- Al retirarlo, el origen conserva sus datos y copias en `DATA_ROOT/<slug>.migrated-<fecha>` (o los borra, con «Borrar el origen al terminar»). Bórralos a mano cuando ya no los necesites.
- La copia previa queda en el destino, en la lista de copias del servidor.

**Si algo falla antes de confirmar.** El servidor sigue en su nodo con el mundo intacto, y se vuelve a arrancar si estaba en marcha. Si la copia del destino llegó a arrancar, el origen no arranca hasta haberla borrado: nunca hay dos servidores vivos con el mismo mundo. Mientras tanto la cabecera avisa y las acciones sobre el servidor esperan.

**Lo pendiente.** Si un nodo no responde, la limpieza del destino, el arranque del origen, la confirmación en el destino o la retirada del origen se reintentan cada 30 s y cada vez que el nodo vuelve a conectar. La pestaña dice qué falta y por qué. Si el agente rechaza algo que no se arregla reintentando (por ejemplo, el directorio del destino ya no es el de esta migración), deja de reintentarse y queda anotado para resolverlo a mano. Si un nodo no va a volver, **Cerrar la migración a mano…** deja de reintentar y dice qué queda sin hacer.

**Avisos:**

- **Nodo destino aislado, no muerto.** Si borras el nodo destino, o cierras a mano una migración cuya copia llegó a arrancar allí, y ese nodo solo está aislado de la red, su contenedor puede seguir en marcha. Compruébalo antes de arrancar el servidor en el origen.
- **No restaures la base de datos del panel** a una copia anterior a una migración sin revisar los nodos.
  - El panel creería el servidor en su nodo anterior y le volvería a dar su spec, que arrancaría con lo que quede allí (o con un mundo vacío).
  - El destino ya está protegido: tras confirmar, el agente no borra el servidor aunque se lo pida un panel restaurado.
- **`restartPolicy: always`.** Si el daemon de Docker del origen se reinicia entre el paso 1 y la retirada, arranca el contenedor parado hasta la siguiente reconciliación del agente (≤ 30 s), que lo vuelve a parar. Evita reiniciar Docker en el origen durante una migración, o usa `unless-stopped` (el valor por defecto).
- **Spec tardía.** Si una migración falla justo al crear el servidor en el destino, este puede quedarse sin borrar `DATA_ROOT/<slug>`, vacío. Sería por una orden que el agente ejecutó tarde y es casi imposible. Una migración posterior con ese slug responderá «ya existe»: bórralo a mano.
- **Servidores importados que siguen en su contenedor original** (aún sin «Guardar y aplicar»): al terminar, la retirada del origen elimina ese contenedor, como al eliminar el servidor. Si lo creó Docker Compose, quita ese servicio del compose, o Compose lo volverá a crear en el origen.
- **Servidores con `dataPath`** (datos fuera de `DATA_ROOT`): no se migran, y `dataPath` no se quita desde la configuración. Para migrarlo, elimina el servidor sin borrar datos, mueve la carpeta a `DATA_ROOT/<slug>/data` del nodo y vuelve a importarlo.

## Router (mc-router)

En **Nodos → Router** se activa un [mc-router](https://github.com/itzg/mc-router) por nodo: los jugadores entran a cada servidor por su hostname (`survival.lan`, `creativo.lan`) a través de un único puerto del nodo (25565 por defecto). El hostname de cada servidor se pone en **Configuración → Red**; cada servidor sigue teniendo también su puerto propio. Que `*.lan` resuelva a la IP del nodo es cosa tuya (router de casa, Pi-hole, `/etc/hosts`).

- **Actualiza los agentes antes que el panel.** Un agente sin router rechaza activarlo (el panel lo dice y no guarda nada), pero ignora en silencio el hostname de la spec de un servidor.
- **Autoscale:** mc-router arranca un servidor dormido cuando alguien intenta entrar y lo para tras los minutos configurados sin jugadores. Con él, el panel deja de arrancar y parar por su cuenta los servidores con hostname; **Parar** no impide que un jugador lo vuelva a arrancar al entrar. Sin lista de jugadores, cualquiera que llegue al puerto despierta servidores (y varios a la vez pueden dejar el nodo sin memoria): rellena **Jugadores que pueden despertar servidores** si el puerto da a Internet. Cambiar esa lista reinicia el router (desconecta a quien entró por él). Mientras una copia en frío, una restauración o un bloqueo sin `data` tienen reservado un servidor bajo demanda, el agente borra su contenedor para que mc-router no lo arranque sobre datos a medias, y al terminar lo recrea. Un contenedor recién creado o recreado (también por un cambio de configuración) se arranca aunque el servidor estuviera parado o dormido: mc-router no despierta contenedores que nunca han arrancado; él lo vuelve a dormir tras los minutos sin jugadores.
- **mc-router solo ve, a través del proxy del agente, los contenedores con hostname de router** (ver [Seguridad](#seguridad)); con autoscale, además, los arranca y los para.
- **Migrar un servidor con hostname:** si el router del nodo origen tiene autoscale, la migración se rechaza (mc-router lo arrancaría en el origen a mitad): quita el autoscale o el hostname, migra y vuelve a ponerlo. El hostname tiene que estar libre en el nodo destino, y tras migrar su DNS tiene que apuntar al destino, con el router de ese nodo activo; si no, los jugadores siguen llegando al router del origen, que ya no tiene el servidor.
- **Importar:** la revisión no ofrece el hostname; actívalo después, en Configuración → Red.
- **Borrar un nodo:** con el router activo no se puede; desactívalo antes. Si el nodo está desconectado cuando lo desactivas, el contenedor `mcsm-router` sigue en esa máquina hasta que un agente de esa máquina lo retire (uno dado de alta de nuevo lo hace al conectar; uno sin la configuración anterior, nada más arrancar) o lo borres tú con `docker rm -f mcsm-router`; el panel deja borrar el nodo igualmente para que una máquina perdida no lo bloquee.

## Desarrollo

```bash
mise install            # instala Go y buf (Node 26 y pnpm 12 se instalan aparte)
pnpm install
pnpm dev:api        # panel en :8080
pnpm dev:web        # web en :5173 (proxy a :8080)
docker network create mcsm 2>/dev/null || true
ENROLL_TOKEN=... DATA_ROOT=$PWD/deploy/data docker compose -f deploy/docker-compose.dev.yml up --build
```
Tests:
- Agente: `cd agent && go test ./...`
- Panel: `pnpm test` (desde la raíz)
- Integración con Docker real: `cd agent && go test -tags integration ./...`

### Pruebas de interfaz (E2E)

`pnpm e2e` (= `bash deploy/e2e/run.sh`) construye el compose de despliegue como proyecto `mcsm-test-e2e` (panel en el puerto 18080, servidores en 26600–26620), añade un segundo nodo en `docker:dind` y lanza Playwright en un contenedor. Las capturas quedan en `panel/apps/e2e/screenshots/` y los logs en `deploy/data/e2e/logs/`. `bash deploy/e2e/run.sh up|test|down` ejecuta cada fase por separado y `E2E_KEEP=1` deja todo levantado al terminar. Solo toca recursos `mcsm-test-e2e*`.

Protocolo: edita `proto/`, luego `pnpm gen` y commitea lo generado.

### CI y versiones

GitHub Actions ejecuta en cada push a `main` y en cada PR `buf lint`, `buf breaking` (contra la rama destino del PR), que el código generado esté al día, `go vet` y `go test -race` del agente, y typecheck, tests y build del panel (`.github/workflows/ci.yml`). La integración con Docker real y la E2E solo se ejecutan en local.

Para publicar una versión:

1. Sube `agent/VERSION` (p. ej. `0.10.0`), commitea y haz push.
2. Crea la Release con el tag `v` + esa versión: `gh release create v0.10.0 --generate-notes` (o desde la web). Si es una prerelease (`--prerelease` o un sufijo como `-rc.1`), no mueve `latest` ni `X.Y`.
3. `.github/workflows/release.yml` comprueba que el tag coincide con `agent/VERSION`, repite las comprobaciones de la CI, construye las dos imágenes para `linux/amd64` y `linux/arm64` en runners nativos y las publica en `ghcr.io/javilobo8/` con atestación de procedencia y SBOM. La imagen del panel lleva fijada la del agente de su misma versión (el `docker run` de **Añadir nodo**).

Los paquetes `mcsm-panel` y `mcsm-agent` quedan enlazados al repositorio y, como es público, también lo son (se descargan sin `docker login`). En un fork privado saldrían privados: se cambia en GitHub → **Packages** → cada paquete → **Package settings** → **Change visibility**.

## Seguridad

Pensado para una LAN doméstica y un único administrador. El agente monta el socket de Docker: quien controle el panel obtiene root efectivo en el host de cada nodo (Docker equivale a root). No lo expongas a Internet.

- **Token de configuración inicial.** Crear la contraseña exige el token que el panel escribe en su log (o `PANEL_SETUP_TOKEN`), así que nadie que llegue antes que tú al panel, ni una web de Internet por DNS rebinding, puede fijarla.
- **Sin TLS.** El tráfico entre navegador, panel y agentes va en claro, y el agente no autentica al panel: un equipo de la LAN que suplante al panel (p. ej. con ARP spoofing) puede capturar la contraseña, la cookie y los tokens de nodo, y dar órdenes a los agentes (borrar mundos, lanzar servidores con código propio). Usa una red de confianza.
- **Migrar ejecuta en el destino el mundo del origen.** Plugins, mods y jars incluidos, dentro del contenedor endurecido. Un nodo origen comprometido puede así hacer que el destino ejecute su código. El sha256 protege la copia en el transporte, no frente a un origen malicioso: migra solo desde nodos de confianza. La copia viaja sin cifrar por la LAN, `server.properties` (con la contraseña RCON) incluido.
- **El router (mc-router) ya no recibe el socket de Docker,** sino el socket filtrado del agente (`<DATA_ROOT>/.mcsm-router/docker.sock`, solo de su usuario; el router monta, de solo lectura, el directorio `<DATA_ROOT>/.mcsm-router/`). El proxy solo deja listar, inspeccionar sin variables de entorno, seguir eventos y arrancar/parar servidores con hostname de router, no reservados ni retenidos; rechaza peticiones con cuerpo y APIs de Docker < 1.24. La ruta completa del socket debe caber en 100 bytes y el sistema de ficheros de `DATA_ROOT` debe admitir sockets unix (no CIFS/SMB). El router va además endurecido (sin capacidades, `no-new-privileges`, raíz de solo lectura, límites de memoria y procesos, imagen fijada por digest, logs con rotación). Al actualizar el agente el router se recrea una vez; los reinicios del agente no lo reinician. Si el agente no puede crear el socket, lo reintenta solo (de 1 s a 30 s) y el error se ve en el estado del router. Su puerto es el que se suele abrir a Internet para jugar con amigos: limita quién despierta servidores con la lista de jugadores del autoscale.
- Los servidores corren sin privilegios extra: sin capacidades salvo las que necesita la imagen para arrancar (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`), con `no-new-privileges`, límite de procesos y límite de memoria (por defecto, memoria de la JVM + 1G). Las funciones de itzg que necesitan más capacidades (autopausa/autostop con knockd) no están soportadas.
- **Cabeceras y límite de intentos.** La web se sirve con una CSP restrictiva y `frame-ancestors 'none'`. Los fallos de login tienen un límite global (30 por minuto): si alguien de la LAN fuerza contraseñas, también bloquea un minuto al administrador; reiniciar el panel lo vacía.
- **Secretos en la consola.** La consola oculta la contraseña RCON y la API key de CurseForge.

## Licencia

[MIT](LICENSE).
