export type ProtocolErrorCode =
  /** Not a JSON object at all. */
  | 'MALFORMED_JSON'
  /** A JSON object, but missing or mistyped required content. */
  | 'SCHEMA_INVALID'
  /** A protocol version outside the supported compatibility line. */
  | 'UNSUPPORTED_PROTOCOL_VERSION'
  /** An event type this binding does not know and the producer did not mark ignorable. */
  | 'UNSUPPORTED_EVENT_TYPE';

/** Why a JSON text could not be read as an event. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  /** JSON pointer to the offending value, when known. */
  readonly pointer: string | undefined;

  constructor(code: ProtocolErrorCode, message: string, pointer?: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.pointer = pointer;
  }
}
