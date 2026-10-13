#!/usr/bin/env node
// Minecraft Server List Ping with any hostname in the handshake (what mc-router reads),
// without relying on DNS. Prints {"motd","version","players"} on one line.
//   node deploy/e2e/mc-status.mjs <ip> <port> <hostname>                  status (next state 1)
//   node deploy/e2e/mc-status.mjs <ip> <port> <hostname> --login[=name]   login attempt (next
//     state 2 + Login Start with that player, “e2e” by default): with mc-router's autoscale, it wakes
//     a sleeping server if the player is on the autoscale list (or there is no list).
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
// Login Start (1.21.4): name + UUID (16 bytes).
const second = login ? packet(varint(0x00), str(player), Buffer.alloc(16)) : packet(varint(0x00));

function readVarint(buf, off) {
  let n = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    if (off >= buf.length) return null;
    const b = buf[off++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [n, off];
  }
  throw new Error("varint too long");
}

const sock = net.connect({ host: ip, port });
sock.setTimeout(10_000, () => {
  // When waking a server, mc-router holds the connection until it starts: the attempt already counts.
  if (login) { console.log(JSON.stringify({ login: true, player, bytes: acc.length })); process.exit(0); }
  console.error("no response in 10 s");
  process.exit(2);
});
let acc = Buffer.alloc(0);
sock.on("connect", () => sock.write(Buffer.concat([handshake, second])));
sock.on("data", (d) => {
  acc = Buffer.concat([acc, d]);
  if (login) return; // any response will do: printed on close
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
  console.error("connection closed without a status response");
  process.exit(1);
});
