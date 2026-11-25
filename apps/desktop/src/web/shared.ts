import type { ControlState } from "./control.js";

export interface WebDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface WebStatus {
  deviceId?: string;
  origin: string;
  lanOrigin?: string;
  fingerprint?: string;
  addresses: string[];
  devices: WebDevice[];
  control: ControlState;
}

export interface WebAccessApi {
  status(): Promise<WebStatus>;
  takeControl(): Promise<ControlState>;
  pair(): Promise<{ url: string; expiresAt: number; qr: string }>;
  revoke(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  listen(ip?: string): Promise<WebStatus>;
  exportCertificate(): Promise<boolean>;
  onControl(listener: (state: ControlState) => void): () => void;
}

export const WEB_ACCESS_CHANNEL = "omp-studio:web-access";
export const WEB_CONTROL_CHANNEL = "omp-studio:web-control";
