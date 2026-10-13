import { describe, expect, it } from "vitest";
import { migrate, openDb } from "./db.js";

describe("083_migrations_pending_english", () => {
  it("rewrites the Spanish pending labels saved before the translation", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO nodes (id, name, token_hash, created_at) VALUES ('n', 'n', 'h', 't')").run();
    const add = (id: string, pending: string | null) =>
      db.prepare(`INSERT INTO migrations (id, server_id, source_node_id, target_node_id, source_slug, target_slug, source_version,
        target_version, target_port, target_spec, was_running, delete_source, phase, pending_error, created_at, updated_at)
        VALUES (?, 's', 'n', 'n', 'a', 'a', 1, 1, 25565, '{}', 0, 0, 'rolling_back', ?, 't', 't')`).run(id, pending);
    add("abort", "Limpiar el destino: el nodo no responde");
    add("restart", "Volver a arrancar el origen: Docker: sin memoria");
    add("confirm", "Confirmar en el destino: x; no se reintenta: arréglalo a mano");
    add("retire", "Retirar el origen: y");
    add("english", "Remove the source: already English");
    add("none", null);
    db.prepare("DELETE FROM schema_migrations WHERE name = '083_migrations_pending_english'").run();
    migrate(db);
    const rows = db.prepare("SELECT id, pending_error AS p FROM migrations ORDER BY id").all();
    expect(rows).toEqual([
      { id: "abort", p: "Clean up the target: el nodo no responde" },
      { id: "confirm", p: "Confirm on the target: x; not retried: arréglalo a mano" },
      { id: "english", p: "Remove the source: already English" },
      { id: "none", p: null },
      { id: "restart", p: "Start the source again: Docker: sin memoria" },
      { id: "retire", p: "Remove the source: y" },
    ]);
  });
});
