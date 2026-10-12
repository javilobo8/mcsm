import { describe, expect, it } from "vitest";
import { buildSpec, diffSpec, kvToText, textToKv, valuesFromSpec, type FormSpec } from "./spec-form";

const base: FormSpec = {
  type: "PAPER", version: "1.21.4", imageTag: "java21", memory: "4G", restartPolicy: "unless-stopped",
  ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "bedrock" }] },
  resources: { cpus: 2, memLimit: "6G" }, properties: { motd: "hola", "max-players": "10" }, env: { USE_AIKAR_FLAGS: "true" },
  rconPassword: "supersecreto",
};

describe("spec-form", () => {
  it("kv ida y vuelta, comentarios y error de línea", () => {
    expect(textToKv("# c\na=b\n\nc = d=e")).toEqual({ a: "b", c: "d=e" });
    expect(textToKv(kvToText({ x: "1", y: "2" }))).toEqual({ x: "1", y: "2" });
    expect(() => textToKv("sinigual")).toThrow(/clave=valor/);
    expect(() => textToKv("=v")).toThrow();
  });
  it("sin cambios, la spec enviada es la completa y conserva extra, recursos y env", () => {
    const out = buildSpec(base, valuesFromSpec(base));
    expect(out).toEqual({ ...base, rconPassword: undefined });
    expect(out).not.toHaveProperty("rconPassword");
    expect(out.ports.extra).toHaveLength(1);
    expect(out.resources).toEqual({ cpus: 2, memLimit: "6G" });
  });
  it("un cambio solo toca ese campo", () => {
    const out = buildSpec(base, { ...valuesFromSpec(base), memory: "5G" });
    expect(out.memory).toBe("5G");
    expect(out.env).toEqual(base.env);
    expect(out.properties).toEqual(base.properties);
  });
  it("valida con los esquemas compartidos", () => {
    const v = valuesFromSpec(base);
    expect(() => buildSpec(base, { ...v, memory: "abc" })).toThrow(/memoria/i);
    expect(() => buildSpec(base, { ...v, port: "70000" })).toThrow(/puerto/i);
    expect(() => buildSpec(base, { ...v, env: "RCON_PORT=1" })).toThrow(/reservada/);
    expect(() => buildSpec(base, { ...v, memory: "8G" })).toThrow(/memLimit/);
  });
  it("diff lista solo lo cambiado y ignora rconPassword", () => {
    const next = buildSpec(base, { ...valuesFromSpec(base), memory: "5G", properties: "motd=hola" });
    const d = diffSpec(base, next);
    expect(d.map((c) => c.path)).toEqual(["memory", "properties.max-players"]);
    expect(d[0]).toEqual({ path: "memory", before: "4G", after: "5G" });
    expect(d[1]!.after).toBe("(vacío)");
    expect(diffSpec(base, { ...base, rconPassword: "otra-cosa-distinta" })).toEqual([]);
  });
});
