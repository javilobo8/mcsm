import type { ConnectAddress } from "@mcsm/shared";
import type { ServerDto } from "@/lib/api";
import { serverAddress } from "@/lib/connect";
import { useNodeRouter } from "@/hooks/use-router";

/** Address players use to join the server (Settings → Connection address) and, under it, its own port. */
export function ServerAddress({ server, connect }: { server: ServerDto; connect: ConnectAddress | undefined }) {
  const routed = !!(server.spec.router?.enabled && server.spec.router.hostname);
  return routed
    ? <RoutedAddress server={server} connect={connect} />
    : <AddressView address={serverAddress(server, connect, null)} port={server.spec.ports.game} />;
}

/** Through mc-router the port is the router's (unless an external one is configured). */
function RoutedAddress({ server, connect }: { server: ServerDto; connect: ConnectAddress | undefined }) {
  const router = useNodeRouter(server.nodeId);
  return <AddressView address={serverAddress(server, connect, router.data?.spec.port ?? null)} port={server.spec.ports.game} />;
}

function AddressView({ address, port }: { address: string | null; port: number }) {
  if (!address) return <span className="font-mono text-sm">{port}</span>;
  return (
    <div className="min-w-0">
      <div data-testid="server-address" className="select-all break-all font-mono text-sm">{address}</div>
      <div className="text-xs text-muted-foreground">port {port}</div>
    </div>
  );
}
