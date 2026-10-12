export const nowIso = (): string => new Date().toISOString();
export const plusSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();
