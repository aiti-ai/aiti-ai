/**
 * sigv4 — Volcengine OpenAPI signature V4 (AK/SK), pure node:crypto, no network.
 *
 * Signs the control-plane gateway (open.volcengineapi.com) for the ark service.
 * The algorithm is the volcano variant of SigV4 and differs from AWS in three
 * places (cross-checked against the community dsh-ark-quota / cc-switch
 * implementations, both verified against the live gateway):
 *   1. canonical headers use a FIXED order `host;x-date;x-content-sha256;content-type`
 *      (NOT alphabetical);
 *   2. the algorithm string is `HMAC-SHA256` (no "AWS4" prefix), the credential
 *      scope ends in `request` (not `aws4_request`), and the signing key is
 *      kDate = HMAC(SK, date) with the SK NOT prefixed;
 *   3. canonical query keys are still sorted alphabetically (like SigV4).
 *
 * Quota actions all use an empty POST body.
 */

import { createHash, createHmac } from "node:crypto";

export const OPENAPI_HOST = "open.volcengineapi.com";
export const ARK_SERVICE = "ark";
export const DEFAULT_REGION = "cn-beijing";
export const OPENAPI_VERSION = "2024-01-01";
export const CONTENT_TYPE = "application/json; charset=utf-8";
export const SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";

const hmacSha256 = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();
const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

// RFC3986 unreserved chars pass through; everything else is %XX-encoded.
function uriEncode(input: string): string {
  return encodeURIComponent(input).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface Sigv4Params {
  accessKeyId: string;
  secretAccessKey: string;
  action: string;
  region?: string;
  version?: string;
  host?: string;
  /** Injectable for deterministic tests. */
  now?: Date;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Canonical query string: Action / Region / Version sorted by key. */
export function canonicalQuery(params: { action: string; region: string; version: string }): string {
  return [
    ["Action", params.action],
    ["Region", params.region],
    ["Version", params.version],
  ]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");
}

/** Build the fully-signed request for one OpenAPI action: `{ url, headers }`. */
export function buildSignedRequest(params: Sigv4Params): SignedRequest {
  const region = params.region || DEFAULT_REGION;
  const version = params.version || OPENAPI_VERSION;
  const host = params.host || OPENAPI_HOST;
  const query = canonicalQuery({ action: params.action, region, version });
  const xDate = (params.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const shortDate = xDate.slice(0, 8);
  const body = Buffer.from("");
  const xContentSha256 = sha256Hex(body);
  const canonicalHeaders =
    `host:${host}\n` +
    `x-date:${xDate}\n` +
    `x-content-sha256:${xContentSha256}\n` +
    `content-type:${CONTENT_TYPE}\n`;
  const canonicalRequest =
    `POST\n/\n${query}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${xContentSha256}`;
  const credentialScope = `${shortDate}/${region}/${ARK_SERVICE}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const kDate = hmacSha256(params.secretAccessKey, shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, ARK_SERVICE);
  const kSigning = hmacSha256(kService, "request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");
  return {
    url: `https://${host}/?${query}`,
    headers: {
      "X-Date": xDate,
      "X-Content-Sha256": xContentSha256,
      "Content-Type": CONTENT_TYPE,
      Authorization: `HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    },
  };
}
