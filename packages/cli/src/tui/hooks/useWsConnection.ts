/**
 * Hook that tracks the WebSocket connection state of a WsClient.
 *
 * Listens for 'connected' and 'disconnected' events on the WsClient
 * and exposes a simple boolean + state string for the StatusBar.
 * Properly removes listeners on unmount to prevent memory leaks.
 */

import { useState, useEffect } from "react";
import type { WsClient, WsConnectionState } from "../../lib/ws-client.js";

export interface UseWsConnectionResult {
  connected: boolean;
  state: WsConnectionState;
}

export function useWsConnection(ws: WsClient): UseWsConnectionResult {
  const [state, setState] = useState<WsConnectionState>(ws.state);

  useEffect(() => {
    // Sync initial state in case it changed between render and effect
    setState(ws.state);

    const onConnected = () => setState("connected");
    const onDisconnected = () => setState("disconnected");
    const onReconnecting = () => setState("reconnecting");

    ws.on("connected", onConnected);
    ws.on("disconnected", onDisconnected);
    ws.on("reconnecting", onReconnecting);

    return () => {
      ws.removeListener("connected", onConnected);
      ws.removeListener("disconnected", onDisconnected);
      ws.removeListener("reconnecting", onReconnecting);
    };
  }, [ws]);

  return {
    connected: state === "connected",
    state,
  };
}
