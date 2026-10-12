Tengo en casa un servidor con un docker compose con varios servidores de minecraft, estos los he ido jugando poco a poco con mi pareja, en diferentes epocas.

Quiero hacer una aplicación profesional, selfhosted, que solo use yo para poder gestionar los servidores de minecraft.

Actualmente estoy usando la imagen https://github.com/itzg/docker-minecraft-server para crear los servidores.

Todos van sobre docker, me gustaría poder gestionarlos todos desde la web, ver su estado, cuantos jugadores hay conectados, etc.

yo soy administrador de todos los servidores, de momento, solo yo.

La web será interna, accedo yo solamente desde la red de mi casa.

Se deben poder ver los logs de las instancias de minecraft directamente.

Se pueden poner mods, modpacks, lo mismo que permite la imagen. 

Absolutamente toda la gestión debe ser configurable desde la web, incluyendo puertos y demás.

Esta gestión estará desde un solo sitio, pero habrá diferentes máquinas, cada maquina debería tener su docker y su agente que orquesta lo que hay en esa maquina, quiero que hagas esta parte muy bien, eficiente. 

Debo poder monitorizar todo desde la misma web. Necesito que sea muy fácil gestionar todo. Me gustaria que tuviera backups, plantillas, poder copiar plantillas, etc.

Importante es la gestión sobre docker, ya que cada maquina tendrá el agent, quiero que una maquina se conecte a otra de forma facil, usando un token o similar, asi puedo tener varios nodos. Se deben poder migrar los nodos de un sitio a otro.

Toda la config debe quedarse persistida, ya sea en una base de datos o lo que veas.

Haz una investigación de todo esto y preguntame lo que sea.