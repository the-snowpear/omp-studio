export type ClientSessionId = string;
export type AuthGeneration = number;
export type AuthzRevision = number;

export type SecurityPrincipal =
  | { kind: "desktop-main"; installationId: string }
  | { kind: "web-client"; clientId: string; deviceId?: string };

export type ClientRole = "observer" | "controller" | "administrator";

export type SecurityRisk =
  | "observe"
  | "control"
  | "workspace-write"
  | "terminal"
  | "preview-read"
  | "browser-input"
  | "network"
  | "os-control"
  | "admin";

export interface ClientGrant {
  clientId: string;
  role: ClientRole;
  projectIds: string[];
  threadIds?: string[];
  risks: SecurityRisk[];
  issuedAt: number;
  expiresAt: number;
  authGeneration: AuthGeneration;
  authzRevision: AuthzRevision;
}

export type TransportSecurityContext =
  | {
      kind: "desktop-private-ipc";
      peerUserId: string;
      channelBinding: string;
      authorityEpoch: AuthorityEpoch;
    }
  | {
      kind: "web-loopback";
      peerAddress: string;
      host: string;
      origin: string;
      csrfVerified: boolean;
      authorityEpoch: AuthorityEpoch;
    }
  | {
      kind: "web-remote-tls";
      peerAddress: string;
      host: string;
      origin: string;
      csrfVerified: boolean;
      tlsVersion: string;
      clientCertificateId?: string;
      authorityEpoch: AuthorityEpoch;
    };

export interface ClientSession {
  sessionId: ClientSessionId;
  principal: SecurityPrincipal;
  grant: ClientGrant;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface PairingChallenge {
  pairingId: string;
  secretHash: string;
  intendedTransport: "web-loopback" | "web-remote-tls";
  expiresAt: number;
  remainingAttempts: number;
  consumedAt?: number;
}

export interface CsrfBinding {
  clientSessionId: ClientSessionId;
  tokenHash: string;
  authGeneration: AuthGeneration;
  expiresAt: number;
}

export interface WebOriginPolicy {
  exactHosts: string[];
  exactOrigins: string[];
  allowedMethods: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
  allowedRequestHeaders: string[];
  allowCredentials: boolean;
  rejectLoopbackPeerWithNonLoopbackHost: boolean;
}

export interface RemoteTlsPolicy {
  enabled: boolean;
  minimumVersion: "TLSv1.2" | "TLSv1.3";
  certificateSource: "host" | "trusted-reverse-proxy";
  trustedProxyAddresses?: string[];
  requireClientCertificate: boolean;
  projectAllowlist: string[];
}

export interface AuthorizationRequest {
  operation: string;
  projectId?: string;
  threadId?: string;
  requiredRisks: SecurityRisk[];
  expectedAuthzRevision: AuthzRevision;
  expectedRuntimeEpoch?: string;
  expectedControlLeaseRevision?: number;
  expectedWorkspaceLeaseRevision?: number;
}

export type AuthorizationDecision =
  | { allowed: true; checkedAt: number }
  | {
      allowed: false;
      reason:
        | "session-expired"
        | "session-revoked"
        | "stale-authz-revision"
        | "scope-denied"
        | "risk-denied"
        | "stale-runtime"
        | "lease-required";
      checkedAt: number;
    };

export type PtyPermission = "read" | "write" | "resize" | "signal";

/** Stored server-side. The bearer secret is returned once and only its hash is retained. */
export interface PtyAttachTicketRecord {
  ticketId: string;
  secretHash: string;
  clientSessionId: ClientSessionId;
  terminalId: string;
  terminalGeneration: string;
  permissions: PtyPermission[];
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
}

/** Authenticated response body; never serialize into a URL or log. */
export interface PtyAttachTicketGrant {
  ticketId: string;
  secret: string;
  terminalId: string;
  terminalGeneration: string;
  permissions: PtyPermission[];
  expiresAt: number;
}

export interface PreviewSecurityProfile {
  previewId: string;
  generation: string;
  projectId: string;
  allowedOrigins: string[];
  partition: { kind: "non-persistent"; name: string };
  sandbox: true;
  contextIsolation: true;
  nodeIntegration: false;
  webSecurity: true;
  preload: null;
  permissions: "deny-by-default";
  navigation: "bound-origin-only";
  downloads: "deny-by-default";
  popups: "deny-by-default";
  sharesHostCredentials: false;
}

export interface HostToolSecurityPolicy {
  capabilityId: string;
  projectId: string;
  threadId: string;
  runtimeEpoch: string;
  previewId?: string;
  requiredRisks: SecurityRisk[];
  approval: "never" | "once-per-session" | "each-call";
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  allowedOrigins?: string[];
}

export interface ProcessContainmentPolicy {
  domainId: string;
  kind: "omp" | "terminal" | "preview" | "helper";
  generation: string;
  ownerProjectId?: string;
  ownerThreadId?: string;
  killTreeOnClose: true;
  allowBreakaway: false;
  gracefulStopMs: number;
  forceStopMs: number;
  maxBufferedOutputBytes: number;
}

export interface MarkdownSecurityPolicy {
  rawHtml: "disabled" | "sanitize-allowlist";
  allowedLinkSchemes: Array<"https" | "http" | "mailto">;
  allowRemoteImages: boolean;
  allowedDataImageTypes: string[];
  maxInlineImageBytes: number;
  allowEval: false;
  allowObjectEmbed: false;
}

/**
 * ProcessContainmentPolicy is a lifecycle/resource contract, not an OS sandbox.
 * It makes no claim that a child cannot access files, credentials, network or
 * other processes. Such claims require a separate, platform-specific sandbox.
 */
import type { AuthorityEpoch } from "./domain-types";
