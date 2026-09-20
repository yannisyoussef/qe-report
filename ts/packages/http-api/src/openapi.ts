import { COMMON_RESPONSE_HEADERS, COMPONENT_SCHEMAS, ROUTES, type RouteSpec } from './schemas.js';

type Schema = Record<string, unknown>;

/** The protocol value objects a response carries as the protocol shapes them, by contract name. */
const PROTOCOL_ROOTS: Readonly<Record<string, string>> = {
  ProtocolComponent: 'component',
  ProtocolStringMap: 'stringMap',
  ProtocolFailure: 'failure',
  ProtocolLocation: 'location',
  ProtocolPathSegment: 'pathSegment',
  ProtocolTestCase: 'testCase',
};

function protocolName(def: string): string {
  return `Protocol${def.charAt(0).toUpperCase()}${def.slice(1)}`;
}

/** A copy with every `#/$defs/x` reference pointing at the contract's name for it. */
function rewrite(value: unknown, used: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, used));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')) {
      const def = v.slice('#/$defs/'.length);
      used.add(def);
      out[key] = `#/components/schemas/${protocolName(def)}`;
    } else {
      out[key] = rewrite(v, used);
    }
  }
  return out;
}

/** The protocol definitions the contract needs, the ones they refer to included, sorted by name. */
function protocolSchemas(protocol: { $defs: Record<string, Schema> }): Record<string, Schema> {
  const defs = protocol.$defs;
  const sessionStarted = defs['event.session.started'] as {
    properties: { payload: { properties: Record<string, Schema> } };
  };
  const payload = sessionStarted.properties.payload.properties;
  const out: Record<string, Schema> = {};
  const used = new Set<string>();
  const pending = new Set<string>(Object.values(PROTOCOL_ROOTS));
  out.ProtocolExecutor = rewrite(payload.executor, used) as Schema;
  out.ProtocolSource = rewrite(payload.source, used) as Schema;
  for (const def of used) pending.add(def);
  const done = new Set<string>();
  while (pending.size > 0) {
    const [def] = pending;
    if (def === undefined) break;
    pending.delete(def);
    if (done.has(def)) continue;
    done.add(def);
    const schema = defs[def];
    if (schema === undefined) throw new Error(`the protocol schema has no definition ${def}`);
    const found = new Set<string>();
    out[protocolName(def)] = rewrite(schema, found) as Schema;
    for (const next of found) if (!done.has(next)) pending.add(next);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function openApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9]+)/gu, '{$1}');
}

function parameters(route: RouteSpec): Schema[] {
  const out: Schema[] = [];
  const add = (where: 'path' | 'query', schema: Schema | undefined): void => {
    if (schema === undefined) return;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const required = new Set((schema.required ?? []) as string[]);
    for (const [name, property] of Object.entries(properties)) {
      out.push({
        name,
        in: where,
        required: where === 'path' || required.has(name),
        schema: property,
      });
    }
  };
  add('path', route.params);
  add('query', route.querystring);
  return out;
}

function operation(route: RouteSpec): Schema {
  const responses: Record<string, Schema> = {};
  for (const [status, response] of Object.entries(route.responses)) {
    responses[status] = {
      description: response.description,
      headers: { ...COMMON_RESPONSE_HEADERS, ...(response.headers ?? {}) },
      ...(response.content === undefined
        ? {}
        : { content: { [response.content.mediaType]: { schema: response.content.schema } } }),
    };
  }
  const params = parameters(route);
  const body =
    route.body !== undefined
      ? { mediaType: 'application/json', schema: route.body }
      : route.requestBody;
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.scope === undefined
      ? { security: [] }
      : { security: [{ apiKey: [] }], 'x-qe-report-scope': route.scope }),
    ...(params.length === 0 ? {} : { parameters: params }),
    ...(body === undefined
      ? {}
      : {
          requestBody: { required: true, content: { [body.mediaType]: { schema: body.schema } } },
        }),
    responses,
  };
}

/**
 * The OpenAPI 3.1 contract of API v1, generated from the same route table the server registers
 * and from the protocol schema's own definitions, so neither can say something the other does
 * not. The output depends on nothing but its inputs: the same tables give the same document.
 */
export function generateOpenApi(protocol: { $defs: Record<string, Schema> }): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const route of ROUTES) {
    const at = openApiPath(route.url);
    paths[at] = { ...(paths[at] ?? {}), [route.method.toLowerCase()]: operation(route) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'qe-report API',
      version: '1',
      description:
        'Transport API version 1 of qe-report. It is independent of the protocol version (0.3), the database schema version, the query-index version, and the package version. Every authenticated operation acts on the project its API key belongs to; no request names a project. Bearer API keys must only travel over HTTPS; TLS is expected at the deployment or reverse-proxy boundary.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A project-scoped API key, `qer_k1_<publicId>_<secret>`, issued by an operator. Its scope (runs:read or runs:write) is named by each operation in x-qe-report-scope.',
        },
      },
      schemas: { ...COMPONENT_SCHEMAS, ...protocolSchemas(protocol) },
    },
  };
}
