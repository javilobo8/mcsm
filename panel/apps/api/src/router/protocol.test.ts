import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { EnvelopeSchema } from "@mcsm/proto";
import { isResponseCase } from "../agents/hub.js";

describe("protocolo del router", () => {
  it("ningún cuerpo del router resuelve una petición: RouterApply/RouterRemove responden con Ack", () => {
    for (const c of ["routerApply", "routerRemove", "routerObserved"]) expect(isResponseCase(c)).toBe(false);
  });

  it("los mensajes nuevos viajan en Envelope.body con sus campos", () => {
    const apply = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, {
      id: 7n, body: { case: "routerApply", value: { spec: { hostPort: 25565, autoscale: true, autoscaleDownAfterMinutes: 15 } } },
    })));
    expect(apply.body.case).toBe("routerApply");
    if (apply.body.case !== "routerApply") throw new Error();
    expect(apply.body.value.spec).toMatchObject({ hostPort: 25565, autoscale: true, autoscaleDownAfterMinutes: 15 });

    const remove = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, { id: 8n, body: { case: "routerRemove", value: {} } })));
    expect(remove.body.case).toBe("routerRemove");

    const obs = fromBinary(EnvelopeSchema, toBinary(EnvelopeSchema, create(EnvelopeSchema, {
      body: { case: "routerObserved", value: { configured: true, state: "running", containerId: "c1", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: false, error: "", tsUnixMs: 5n } },
    })));
    expect(obs.id).toBe(0n);
    if (obs.body.case !== "routerObserved") throw new Error();
    expect(obs.body.value).toMatchObject({ configured: true, state: "running", hostPort: 25565, tsUnixMs: 5n });
  });
});
