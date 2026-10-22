import type { ConnectAddress } from "@mcsm/shared";
import type { ServerDto } from "@/lib/api";
import { rconAddress, serverAddress } from "@/lib/connect";
import { useNodeRouter } from "@/hooks/use-router";

/** Address players use to join the server (Settings → Connection address) and, under it, its own port. */
export function ServerAddress({ server, connect }: { server: ServerDto; connect: ConnectAddress | undefined }) {
  const routed = !!(server.spec.router?.enabled && server.spec.router.hostname);
  const rcon = rconAddress(server, connect);
  return routed
    ? <RoutedAddress server={server} connect={connect} rcon={rcon} />
    : <AddressView address={serverAddress(server, connect, null)} port={server.spec.ports.game} rcon={rcon} />;
}

/** Through mc-router the port is the router's (unless an external one is configured). */
function RoutedAddress({ server, connect, rcon }: { server: ServerDto; connect: ConnectAddress | undefined; rcon: string | null }) {
  const router = useNodeRouter(server.nodeId);
  return <AddressView address={serverAddress(server, connect, router.data?.spec.port ?? null)} port={server.spec.ports.game} rcon={rcon} />;
}

function AddressView({ address, port, rcon }: { address: string | null; port: number; rcon: string | null }) {
  const rconLine = rcon && <div data-testid="server-rcon-address" className="select-all break-all font-mono text-xs text-muted-foreground">RCON {rcon}</div>;
  if (!address) return rcon ? <div><span className="font-mono text-sm">{port}</span>{rconLine}</div> : <span className="font-mono text-sm">{port}</span>;
  return (
    <div className="min-w-0">
      <div data-testid="server-address" className="select-all break-all font-mono text-sm">{address}</div>
      <div className="text-xs text-muted-foreground">port {port}</div>
      {rconLine}
    </div>
  );
}
