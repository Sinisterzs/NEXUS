import { gatewayClient, GatewayClient, GatewayEventListener } from './GatewayClient';

export { gatewayClient, GatewayClient };
export type { GatewayEventListener as WsEventListener };

// Alias for existing imports
export const webSocketService = gatewayClient;
