#!/usr/bin/env node
// Server List Ping de Minecraft con el hostname que se quiera en el handshake (lo que lee mc-router),
// sin depender del DNS. Imprime {"motd","version","players"} en una línea.
//   node deploy/e2e/mc-status.mjs <ip> <puerto> <hostname>                  estado (siguiente estado 1)
//   node deploy/e2e/mc-status.mjs <ip> <puerto> <hostname> --login[=nombre]  intento de entrada (siguiente
//     estado 2 + Login Start con ese jugador, «e2e» por defecto): con el autoscale de mc-router, despierta
//     un servidor dormido si el jugador está en la lista del autoscale (o no hay lista).
import net from "node:net";

const [ip = "127.0.0.1", portArg = "25565", host = ip, flag = ""] = process.argv.slice(2);
const port = Number(portArg);
const login = flag === "--login" || flag.startsWith("--login=");
const player = flag.startsWith("--login=") ? flag.slice("--login=".length) : "e2e";

const varint = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const str = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([varint(b.length), b]);
};
const packet = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varint(body.length), body]);
};
const u16 = Buffer.alloc(2);
u16.writeUInt16BE(port);
const handshake = packet(varint(0x00), varint(769), str(host), u16, varint(login ? 2 : 1));
// Login Start (1.21.4): nombre + UUID (16 bytes).
const second = login ? packet(varint(0x00), str(player), Buffer.alloc(16)) : packet(varint(0x00));

function readVarint(buf, off) {
  let n = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    if (off >= buf.length) return null;
    const b = buf[off++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [n, off];
  }
  throw new Error("varint demasiado largo");
}

const sock = net.connect({ host: ip, port });
sock.setTimeout(10_000, () => {
  // Al despertar un servidor, mc-router retiene la conexión hasta que arranca: el intento ya cuenta.
  if (login) { console.log(JSON.stringify({ login: true, player, bytes: acc.length })); process.exit(0); }
  console.error("sin respuesta en 10 s");
  process.exit(2);
});
let acc = Buffer.alloc(0);
sock.on("connect", () => sock.write(Buffer.concat([handshake, second])));
sock.on("data", (d) => {
  acc = Buffer.concat([acc, d]);
  if (login) return; // cualquier respuesta vale: se imprime al cerrar
  const head = readVarint(acc, 0);
  if (!head || acc.length < head[1] + head[0]) return;
  const body = acc.subarray(head[1], head[1] + head[0]);
  const [, afterId] = readVarint(body, 0);
  const [len, start] = readVarint(body, afterId);
  const json = JSON.parse(body.subarray(start, start + len).toString("utf8"));
  const desc = json.description;
  const motd = typeof desc === "string" ? desc : (desc?.text ?? "") + (desc?.extra ?? []).map((e) => e?.text ?? "").join("");
  console.log(JSON.stringify({ motd, version: json.version?.name ?? "", players: json.players?.online ?? 0 }));
  sock.end();
  process.exit(0);
});
sock.on("error", (e) => { console.error(e.message); process.exit(1); });
sock.on("close", () => {
  if (login) { console.log(JSON.stringify({ login: true, player, bytes: acc.length })); process.exit(0); }
  console.error("conexión cerrada sin respuesta de estado");
  process.exit(1);
});
