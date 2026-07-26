/** The shared package is the authoritative runtime/UI wire contract. */
export * as StewardProtocol from '#shared/protocol';

export {
  ControlPlaneProtocolError,
  ControlPlaneTransportError,
  createHttpControlPlaneGateway,
  type ControlPlaneGateway,
  type HttpControlPlaneGatewayOptions,
  type UiEventStreamTermination,
  type UiEventSubscription,
} from './http-gateway';
export * from './workspace-client';

// Compatibility-only exports for the pre-runtime prototype. New transport code
// must import wire types and parsers from #shared/protocol.
export * from './contract';
export * from './reconciliation';
