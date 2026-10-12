import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { EnvelopeSchema } from "@mcsm/proto";
import { isResponseCase } from "../agents/hub.js";

describe("protocolo de la migración", () => {
  it("solo BackupPushResult resuelve una petición; los demás cuerpos son órdenes", () => {
    expect(isResponseCase("backupPushResult")).toBe(true);
    for (const c of ["backupPush", "migrateReceive", "migrateAbort", "migrateRetire", "migrateConfirm"]) expect(isResponseCase(c)).toBe(false);
  });

  it("los mensajes nuevos viajan en Envelope.body con sus campos", () => {
    const rx = create(EnvelopeSchema, { id: 7n, body: { case: "migrateReceive", value: {
      serverId: "s", slug: "uno", jobId: "j", migrationId: "m", transferId: "t",
      filename: "uno-20261012T040000.000Z-1.tar.zst", sizeBytes: 10n, sha256: "ab".repeat(32), dataBytes: 20n,
    } } });
    const back = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, rx));
    expect(back.body.case).toBe("migrateReceive");
    if (back.body.case !== "migrateReceive") throw new Error();
    expect(back.body.value).toMatchObject({ slug: "uno", sizeBytes: 10n, dataBytes: 20n, migrationId: "m" });

    const retire = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, {
      body: { case: "migrateRetire", value: { serverId: "s", slug: "uno", migrationId: "m", deleteData: true, sourceVersion: 4n } },
    })));
    if (retire.body.case !== "migrateRetire") throw new Error();
    expect(retire.body.value).toMatchObject({ deleteData: true, sourceVersion: 4n });

    const confirm = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, {
      id: 8n, body: { case: "migrateConfirm", value: { serverId: "s", slug: "uno", migrationId: "m" } },
    })));
    expect(confirm.body.case).toBe("migrateConfirm");

    const res = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, {
      id: 9n, body: { case: "backupPushResult", value: { sizeBytes: 5n, sha256: "cd".repeat(32), dataBytes: 9n } },
    })));
    expect(res.body.case).toBe("backupPushResult");
  });
});
