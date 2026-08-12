import { WebTransportError } from "./errors.js";

/**
 * Defensive deep clone for transport envelope data.
 *
 * Contract payloads are plain JSON data: primitives, arrays, records and
 * `Date` instances (preserved like the desktop transport). Anything else
 * (functions, symbols, class instances, Map/Set) is a protocol violation
 * and fails closed with {@link WebTransportError} instead of being
 * forwarded. `undefined` properties are preserved; the web adapter and its
 * api never share object identity, so neither side can observe the other's
 * later mutations.
 */
export function cloneEnvelopeValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new WebTransportError(
        "TRANSPORT_ERROR",
        "envelope contains a non-JSON value (function or symbol)",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      items[index] = cloneEnvelopeValue(value[index]);
    }
    return items as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WebTransportError(
      "TRANSPORT_ERROR",
      "envelope contains a non-plain object",
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    copy[key] = cloneEnvelopeValue(record[key]);
  }
  return copy as T;
}
