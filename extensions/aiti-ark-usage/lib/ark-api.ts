/**
 * ark-api — hardened gateway fetch for the ark control-plane quota actions.
 *
 * Mirrors the provider-usage secure-fetch posture: explicit UA, redirect
 * refused, 15s timeout, 64KB cap, key material never logged. The request URL
 * is always the signed gateway URL produced by buildSignedRequest (host is
 * additionally pinned to *.volcengineapi.com by the config layer).
 */

import { buildSignedRequest, type SignedRequest } from "./sigv4.ts";

const USER_AGENT = "pi-web-aiti-ark-usage/0.1";
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 65_536;

export class ArkApiError extends Error {
  /** Upstream error envelope code, when the gateway answered with one. */
  code?: string;
  /** HTTP status of the gateway response (auth-class failures hard-stop on 401/403). */
  status?: number;
}

export interface ArkGatewayOptions {
  accessKeyId: string;
  secretAccessKey: string;
  action: string;
  region?: string;
  gatewayHost?: string;
  now?: Date;
}

/** Run one signed quota action, returning the gateway `Result` object. */
export async function fetchArkResult(options: ArkGatewayOptions): Promise<Record<string, unknown>> {
  const signed: SignedRequest = buildSignedRequest({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    action: options.action,
    ...(options.region ? { region: options.region } : {}),
    ...(options.gatewayHost ? { host: options.gatewayHost } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let response: Response;
  try {
    response = await fetch(signed.url, {
      method: "POST",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...signed.headers },
      body: "",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (caught) {
    throw new ArkApiError(`Volcano Ark gateway request failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new ArkApiError("Volcano Ark gateway response was too large.");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ArkApiError(`Volcano Ark gateway returned HTTP ${response.status} with a non-JSON body.`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ArkApiError("Volcano Ark gateway response was not an object.");
  }
  const envelope = payload as Record<string, unknown>;
  const meta = typeof envelope.ResponseMetadata === "object" && envelope.ResponseMetadata !== null
    ? envelope.ResponseMetadata as Record<string, unknown>
    : {};
  const error = typeof meta.Error === "object" && meta.Error !== null ? meta.Error as Record<string, unknown> : undefined;
  if (error) {
    const code = typeof error.Code === "string" ? error.Code : "UnknownError";
    const message = typeof error.Message === "string" ? error.Message : "no message";
    const apiError = new ArkApiError(`Volcano Ark gateway error ${code}: ${message}`);
    apiError.code = code;
    apiError.status = response.status;
    throw apiError;
  }
  if (!response.ok) {
    const httpError = new ArkApiError(`Volcano Ark gateway returned HTTP ${response.status}.`);
    httpError.status = response.status;
    throw httpError;
  }
  const result = envelope.Result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new ArkApiError("Volcano Ark gateway response carried no Result object.");
  }
  return result as Record<string, unknown>;
}
