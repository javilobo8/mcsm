import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";

const cols = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe("migraciones del Plan 9", () => {
  it("crea events y las columnas del token pendiente", () => {
    const db = openDb(":memory:");
    expect(cols(db, "events")).toEqual(["id", "node_id", "server_id", "server_name", "level", "kind", "message", "agent_at", "created_at"]);
    expect(cols(db, "nodes")).toEqual(expect.arrayContaining(["pending_token_hash", "pending_token_at"]));
    expect(() => db.prepare("INSERT INTO events (id, level, kind, message, created_at) VALUES ('e', 'mal', 'x', 'm', 't')").run()).toThrow(/CHECK/);
  });

  it("el hash pendiente es único entre nodos, pero puede faltar en varios", () => {
    const db = openDb(":memory:");
    const add = (id: string, pending: string | null) =>
      db.prepare("INSERT INTO nodes (id, name, token_hash, pending_token_hash, created_at) VALUES (?, ?, ?, ?, 't')").run(id, id, `h-${id}`, pending);
    add("a", null);
    add("b", null);
    add("c", "p1");
    expect(() => add("d", "p1")).toThrow(/UNIQUE/);
  });

  it("borrar un nodo borra sus eventos", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO nodes (id, name, token_hash, created_at) VALUES ('n', 'n', 'h', 't')").run();
    db.prepare("INSERT INTO events (id, node_id, level, kind, message, created_at) VALUES ('e', 'n', 'info', 'x', 'm', 't')").run();
    db.prepare("DELETE FROM nodes WHERE id = 'n'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });
});
