I have a server at home running a docker compose with several Minecraft servers; my partner and I have been playing on them little by little, in different eras.

I want to build a professional, self-hosted application, for my use only, to manage the Minecraft servers.

I am currently using the image https://github.com/itzg/docker-minecraft-server to create the servers.

They all run on Docker, and I would like to manage them all from the web, see their status, how many players are connected, etc.

I am the administrator of all the servers; for now, only me.

The web UI will be internal, accessed only by me from my home network.

It must be possible to see the Minecraft instances' logs directly.

It must be possible to add mods and modpacks, everything the image allows.

Absolutely all management must be configurable from the web, including ports and so on.

Management will be from a single place, but there will be different machines; each machine should have its own Docker and its own agent that orchestrates what is on that machine. I want you to do this part very well, efficiently.

I must be able to monitor everything from the same web UI. I need it to be very easy to manage everything. I would like it to have backups, templates, the ability to copy templates, etc.

Docker management is important, since each machine will have the agent. I want one machine to connect to another easily, using a token or similar, so I can have several nodes. It must be possible to migrate the nodes from one place to another.

All the configuration must be persisted, whether in a database or whatever you see fit.

Do research on all of this and ask me whatever you need.
