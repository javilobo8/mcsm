# MC Server Manager

Panel self-hosted para gestionar servidores de Minecraft (imagen `itzg/minecraft-server`) repartidos en varias máquinas con Docker. Un panel, un agente por máquina.

## Puesta en marcha (máquina principal)

1. `docker network create mcsm 2>/dev/null || true` (red compartida por el agente y los servidores; los compose la declaran como externa).
2. `cp deploy/.env.example deploy/.env` y edita `PANEL_PUBLIC_URL` (IP de esta máquina; si lo dejas vacío, el panel usa la dirección con la que lo abres en el navegador) y `DATA_ROOT` (ruta absoluta).
3. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build panel`
4. Abre `http://<ip>:8080` **en cuanto arranque** y crea la contraseña: el primer visitante la fija. Ve a **Nodos → Añadir nodo** y copia el token en `ENROLL_TOKEN` del `.env`.
5. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build agent`. El nodo aparece como conectado.

## Añadir otra máquina

Crea la red (`docker network create mcsm 2>/dev/null || true`). En **Nodos → Añadir nodo** copia el `docker run` que se muestra y ejecútalo allí (necesita la imagen `mcsm-agent`: constrúyela con `docker build -t mcsm-agent:latest agent/` o usa `deploy/docker-compose.node.yml` con `PANEL_URL` y `ENROLL_TOKEN`).

`DATA_ROOT` se monta en el agente **con la misma ruta dentro y fuera** (`-v /srv/minecraft:/srv/minecraft`): el agente lo comprueba al arrancar y no arranca si no está montado desde el host.

## Archivos

La pestaña **Archivos** de cada servidor navega por su carpeta `data`, edita ficheros de texto (hasta 2 MiB) y sube y descarga ficheros. Las subidas y descargas van en streaming navegador ↔ panel ↔ agente, sin pasar por el disco del panel.

Configuración del agente (por nodo, variable de entorno):

| Variable | Por defecto | Qué hace |
|---|---|---|
| `UPLOAD_MAX_BYTES` | `4294967296` (4 GiB) | Tamaño máximo de una subida, en bytes. Por encima, el nodo la rechaza con «la subida supera el máximo… (UPLOAD_MAX_BYTES)». Ejemplo para 10 GiB: `UPLOAD_MAX_BYTES=10737418240`. |

Límites fijos, para saber qué esperar:

- Como mucho **4 subidas o descargas a la vez por nodo**; la quinta recibe «el nodo ya tiene 4 transferencias de archivos en curso».
- Una transferencia se corta si pasa **60 s sin moverse un byte** (el agente) o 120 s (el panel); mientras avance, no tiene plazo total.
- Las escrituras son atómicas: un temporal oculto `.mcsm-tmp-…` en la misma carpeta y un `rename` al terminar. Si el agente muere a mitad (corte de luz, `kill -9`), el temporal se borra al volver a arrancar (si lleva más de 1 h sin tocarse). Al pararlo (`docker stop`, actualización), el agente espera hasta 20 s a que las operaciones de archivos en curso terminen o limpien.

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
- Los servidores corren sin privilegios extra: sin capacidades salvo las que necesita la imagen para arrancar (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`), con `no-new-privileges`, límite de procesos y límite de memoria (por defecto, memoria de la JVM + 1G). Las funciones de itzg que necesitan más capacidades (autopausa/autostop con knockd) no están soportadas.
