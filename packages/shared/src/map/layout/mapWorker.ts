// Module worker entry for loadMapWorld: imports only pure map code (no Babylon), so it starts in a few milliseconds.
import { serveMapWorld, type MapWorldMessage, type MapWorldRequest } from "./mapWorld";

interface WorkerScope {
  onmessage: ((event: MessageEvent<MapWorldRequest>) => void) | null;
  postMessage(message: MapWorldMessage, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (event) => {
  void serveMapWorld(event.data, (message, transfer) => scope.postMessage(message, transfer));
};
