# MC Server Manager

Panel self-hosted para gestionar servidores de Minecraft (imagen `itzg/minecraft-server`) repartidos en varias máquinas con Docker. Un panel, un agente por máquina.

## Puesta en marcha (máquina principal)

1. `docker network create mcsm 2>/dev/null || true` (red compartida por el agente y los servidores; los compose la declaran como externa).
2. `cp deploy/.env.example deploy/.env` y edita `PANEL_PUBLIC_URL` (`http://<ip-de-esta-máquina>:8080`, con el puerto: es la dirección que se pone en el `docker run` de los demás nodos; si lo dejas vacío, el panel usa la dirección con la que lo abres en el navegador) y `DATA_ROOT` (ruta absoluta).
3. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build panel`
4. Abre `http://<ip>:8080` **en cuanto arranque** y crea la contraseña (mínimo 8 caracteres): el primer visitante la fija. Ve a **Nodos → Añadir nodo**, pon en «Directorio de datos» el mismo `DATA_ROOT` del `.env` y copia el token en `ENROLL_TOKEN` del `.env`. El token caduca a los 15 minutos y sirve una sola vez.
5. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build agent`. El nodo aparece como conectado. Este agente llega al panel por la red interna del compose (`http://panel:8080`). El alta queda guardada en el volumen `mcsm_agent-data`: a partir de ahí `ENROLL_TOKEN` se ignora.

## Añadir otra máquina

Crea la red (`docker network create mcsm 2>/dev/null || true`). En **Nodos → Añadir nodo** copia el `docker run` que se muestra y ejecútalo allí antes de 15 minutos (necesita la imagen `mcsm-agent`: constrúyela con `docker build -t mcsm-agent:latest agent/` con el repositorio clonado allí, o cópiala desde la principal con `docker save mcsm-agent:latest | ssh <usuario>@<nodo> docker load`; o usa `deploy/docker-compose.node.yml` con `PANEL_URL` y `ENROLL_TOKEN`).

`DATA_ROOT` se monta en el agente **con la misma ruta dentro y fuera** (`-v /srv/minecraft:/srv/minecraft`): el agente lo comprueba al arrancar y no arranca si no está montado desde el host.

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

**Primero los agentes y luego el panel.** Un agente antiguo rechaza lo que no conoce, pero un panel nuevo puede pedirle cosas que todavía no sabe hacer. En cada máquina, `git pull` y:

1. Agentes.
   - En la máquina principal: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --no-deps agent` (`--no-deps`: sin él, Compose también reconstruiría y reiniciaría el panel).
   - En los nodos con compose: `docker compose -f deploy/docker-compose.node.yml --env-file deploy/.env up -d --build`.
   - En los nodos con `docker run`: `docker build -t mcsm-agent:latest agent/`, luego `docker stop mcsm-agent && docker rm mcsm-agent` (con `stop` tiene sus 30 s para terminar; `rm -f` lo mata en el acto) y vuelve a lanzar el mismo `docker run`. El volumen `mcsm-agent-data` conserva el alta, así que el `ENROLL_TOKEN` caducado da igual.
2. Panel: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --no-deps panel`.

Los servidores de Minecraft siguen en marcha mientras se actualizan el agente y el panel. Algunas actualizaciones del agente cambian cómo construye los contenedores y los recrean (cada servidor se reinicia) al volver a arrancar.

## Copia de la base de datos del panel

Todo lo del panel (servidores, nodos, plantillas, historial, contraseña) está en `panel.db`, en el volumen `mcsm_panel-data`. Los mundos y sus copias no: están en el `DATA_ROOT` de cada nodo. Cópiala con el panel parado: los servidores siguen funcionando, pero espera a que no haya copias, restauraciones ni migraciones en curso. Copia el volumen entero: el panel usa WAL y los ficheros `panel.db-wal` y `panel.db-shm` forman parte de la base de datos.

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env stop panel
docker run --rm -v mcsm_panel-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/mcsm-panel-$(date +%F).tgz -C /data .
docker compose -f deploy/docker-compose.yml --env-file deploy/.env start panel
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

Se fija en el `.env` de `deploy/docker-compose.yml` o de `deploy/docker-compose.node.yml` (vacío = el valor por defecto) o, en un nodo arrancado con el `docker run` de **Añadir nodo**, añadiendo `-e UPLOAD_MAX_BYTES=…`.

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
- **Las plantillas se llevan la programación.** «Guardar como plantilla» la incluye y cada servidor creado con la plantilla la hereda; el editor de plantillas y el asistente la enseñan, pero se cambia en la pestaña Backups de cada servidor.

### Restaurar y los datos pre-restore

Restaurar **no borra nada**: para el servidor, extrae la copia en `data.restoring-<fecha>`, aparta los datos actuales en `DATA_ROOT/<slug>/data.pre-restore-<fecha>` y pone la copia en `data`. Después lo vuelve a arrancar si su estado deseado es «en marcha»; si no, se queda parado.

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
- **mc-router descubre cualquier contenedor de la máquina** con la etiqueta `mc-router.host`, no solo los del panel, y con autoscale también los arranca y los para.
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

Protocolo: edita `proto/`, luego `pnpm gen` y commitea lo generado.

## Seguridad

Pensado para una LAN doméstica y un único administrador. El agente monta el socket de Docker: quien controle el panel obtiene root efectivo en el host de cada nodo (Docker equivale a root). No lo expongas a Internet.

- **El primer visitante fija la contraseña.** Hasta que la crees, cualquiera que llegue al panel (incluida una web de Internet que visite alguien de tu LAN, por DNS rebinding) puede fijarla él. Configúrala nada más arrancar el panel.
- **Sin TLS.** El tráfico entre navegador, panel y agentes va en claro, y el agente no autentica al panel: un equipo de la LAN que suplante al panel (p. ej. con ARP spoofing) puede capturar la contraseña, la cookie y los tokens de nodo, y dar órdenes a los agentes (borrar mundos, lanzar servidores con código propio). Usa una red de confianza.
- **Migrar ejecuta en el destino el mundo del origen.** Plugins, mods y jars incluidos, dentro del contenedor endurecido. Un nodo origen comprometido puede así hacer que el destino ejecute su código. El sha256 protege la copia en el transporte, no frente a un origen malicioso: migra solo desde nodos de confianza. La copia viaja sin cifrar por la LAN, `server.properties` (con la contraseña RCON) incluido.
- **El router (mc-router) equivale a root en su nodo.** Necesita el socket de Docker para encontrar los servidores (y, con autoscale, arrancarlos y pararlos), y montarlo en solo lectura no limita la API. Va endurecido (usuario sin privilegios con solo el grupo del socket, sin capacidades, `no-new-privileges`, raíz de solo lectura, límites de memoria y procesos, imagen fijada por digest, logs con rotación), pero un fallo suyo o de su imagen da el control de la máquina. El socket tiene que dar lectura y escritura a su grupo (lo normal, `srw-rw---- root:docker`); con Docker rootless no funciona. Su puerto es el que se suele abrir a Internet para jugar con amigos: limita quién despierta servidores con la lista de jugadores del autoscale.
- Los servidores corren sin privilegios extra: sin capacidades salvo las que necesita la imagen para arrancar (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`), con `no-new-privileges`, límite de procesos y límite de memoria (por defecto, memoria de la JVM + 1G). Las funciones de itzg que necesitan más capacidades (autopausa/autostop con knockd) no están soportadas.
