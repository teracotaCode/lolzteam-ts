#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string): string {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) {
    console.error(`Missing required argument: ${name}`);
    process.exit(1);
  }
  return args[idx + 1];
}

const schemaPath = getArg("--schema");
const outputDir = getArg("--output-dir");
const apiName = getArg("--api-name"); // Forum | Market

fs.mkdirSync(outputDir, { recursive: true });

// ─── Load spec ──────────────────────────────────────────────────────────────
const spec: OpenAPISpec = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

// ─── OpenAPI type stubs (just enough) ───────────────────────────────────────
interface OpenAPISpec {
  paths: Record<string, Record<string, OperationObject | any>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    responses?: Record<string, ResponseObject>;
  };
}
interface SchemaObject {
  type?: string | string[];
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  $ref?: string;
  enum?: (string | number)[];
  oneOf?: SchemaObject[];
  allOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  additionalProperties?: SchemaObject | boolean;
  description?: string;
  title?: string;
  default?: unknown;
  required?: string[];
  "x-enumDescriptions"?: Record<string, string>;
}
interface ParameterObject {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  style?: string;
  explode?: boolean;
  schema?: SchemaObject;
  $ref?: string;
}
interface MediaTypeObject {
  schema?: SchemaObject;
}
interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
  $ref?: string;
}
interface RequestBodyObject {
  content?: Record<string, MediaTypeObject>;
}
interface OperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: (ParameterObject | { $ref: string })[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
}

// ─── $ref resolver ──────────────────────────────────────────────────────────
const resolveCache = new Map<string, unknown>();
const resolving = new Set<string>();

function resolveRef(ref: string): unknown {
  if (resolveCache.has(ref)) return resolveCache.get(ref)!;
  if (resolving.has(ref)) return {}; // cycle protection
  resolving.add(ref);
  const parts = ref.replace(/^#\//, "").split("/");
  let current: any = spec;
  for (const p of parts) {
    current = current?.[p.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  resolving.delete(ref);
  if (current !== undefined) resolveCache.set(ref, current);
  return current ?? {};
}

function resolveSchema(s: SchemaObject | undefined): SchemaObject {
  if (!s) return {};
  if (s.$ref) return resolveSchema(resolveRef(s.$ref) as SchemaObject);
  return s;
}

function resolveParam(p: ParameterObject | { $ref: string }): ParameterObject {
  if ("$ref" in p && p.$ref) return resolveRef(p.$ref) as ParameterObject;
  return p as ParameterObject;
}

function resolveResponse(r: ResponseObject): ResponseObject {
  if (r.$ref) return resolveRef(r.$ref) as ResponseObject;
  return r;
}

// ─── Dynamic dict detection ─────────────────────────────────────────────────
// When ALL property keys in an object schema are purely numeric, this is
// example data from a dynamic dict keyed by IDs, not a real schema.
function isDynamicDict(s: SchemaObject): boolean {
  const props = s.properties;
  if (!props) return false;
  const keys = Object.keys(props);
  if (keys.length === 0) return false;
  return keys.every((k) => /^\d+$/.test(k));
}

// Infer value type for a dynamic dict from its first property schema
function dynamicDictValueType(s: SchemaObject, parentName: string, depth: number): string {
  const props = s.properties;
  if (!props) return "any";
  const firstVal = resolveSchema(Object.values(props)[0]);
  // Nested dynamic dicts are too unpredictable
  if (isDynamicDict(firstVal)) return "any";
  const vtype = firstVal.type;
  if (vtype === "string") return "string";
  if (vtype === "integer" || vtype === "number") return "number";
  if (vtype === "boolean") return "boolean";
  // Complex object value — generate inline
  if ((vtype === "object" || firstVal.properties) && !isDynamicDict(firstVal)) {
    return schemaToTS(firstVal, parentName + "Value", depth + 1);
  }
  return "any";
}

// ─── Field type overrides (API returns different types than spec declares) ───
const FIELD_TYPE_OVERRIDES: Record<string, string> = {
  // Forum: thread_tags is dict of tag_id→tag_name but API also returns []
  thread_tags: "Record<string, any> | any[]",
  // Market: spec says integer, API returns float
  priceWithSellerFee: "number",
  // Market: spec says string, API returns dict
  steam_bans: "any",
  // Market: spec says boolean, API returns object
  guarantee: "any",
  // Market: spec says array, API returns dict
  cs2PremierElo: "any",
  // Market: spec says integer, API returns string "none"
  discord_nitro_type: "any",
  // Market: spec says string, API returns int
  instagram_id: "any",
  // Market: spec says integer, API returns float
  roblox_credit_balance: "number",
  // Market: spec says list of objects, API returns JSON string
  socialclub_games: "any",
  // Market: spec says list[int], API returns dict
  Skin: "Record<string, any> | any[]",
  // Market: spec says list, API returns dict
  WeaponSkins: "Record<string, any> | any[]",
  // Market: spec says list, API returns dict
  supercellBrawlers: "Record<string, any> | any[]",
  // Market: r6Skins can be dict
  r6Skins: "Record<string, any> | any[]",
  // Market: tags can be dict or list
  tags: "Record<string, any> | any[]",
  // Market: category_params values/base_params can be any type
  values: "any",
  base_params: "any",
};

// ─── TS reserved words ──────────────────────────────────────────────────────
const TS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield",
  "as", "implements", "interface", "let", "package", "private", "protected",
  "public", "static", "type", "from", "of",
]);

function safePropName(name: string): string {
  if (TS_RESERVED.has(name) || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return JSON.stringify(name);
  }
  return name;
}

function safeIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (TS_RESERVED.has(cleaned)) return cleaned + "_";
  if (/^[0-9]/.test(cleaned)) return "_" + cleaned;
  return cleaned;
}

// ─── Naming helpers ─────────────────────────────────────────────────────────
function toPascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function toSnakeCase(s: string): string {
  return s
    .replace(/\.+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function tagToGroupName(tag: string): string {
  // "Content Tagging" -> "contentTagging"
  const pascal = toPascalCase(tag);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function operationIdToMethod(operationId: string): string {
  // "Threads.List" -> "list", "Conversations.Messages.Create" -> "messages_create"
  const parts = operationId.split(".");
  // Drop the first part (tag name), join rest with underscore
  const methodParts = parts.slice(1);
  if (methodParts.length === 0) return toSnakeCase(parts[0]);
  return toSnakeCase(methodParts.join("_"));
}

function opIdToTypeName(operationId: string): string {
  // "Threads.List" -> "ThreadsList"
  return toPascalCase(operationId.replace(/\./g, " "));
}

// Strip the [] from param names for use as TS property names
function cleanParamName(name: string): string {
  return name.replace(/\[\]$/, "");
}

// ─── Schema → TypeScript type string ────────────────────────────────────────
// Tracks inline interfaces we need to emit
const inlineInterfaces: { name: string; body: string }[] = [];
let inlineCounter = 0;

function schemaToTS(s: SchemaObject, parentName: string, depth: number = 0): string {
  if (!s) return "unknown";
  if (s.$ref) {
    // Reference to component schema
    const refPath = s.$ref;
    const refName = refPath.split("/").pop()!;
    // Component schemas get exported directly
    if (refPath.startsWith("#/components/schemas/")) {
      return toPascalCase(refName);
    }
    // Otherwise resolve inline
    return schemaToTS(resolveSchema(s), parentName, depth);
  }

  // oneOf / anyOf → union
  if (s.oneOf) {
    const members = s.oneOf.map((sub, i) =>
      schemaToTS(sub, `${parentName}Variant${i + 1}`, depth)
    );
    return "(" + members.join(" | ") + ")";
  }
  if (s.anyOf) {
    const members = s.anyOf.map((sub, i) =>
      schemaToTS(sub, `${parentName}AnyOf${i + 1}`, depth)
    );
    return "(" + members.join(" | ") + ")";
  }
  if (s.allOf) {
    const members = s.allOf.map((sub, i) =>
      schemaToTS(sub, `${parentName}AllOf${i + 1}`, depth)
    );
    return "(" + members.join(" & ") + ")";
  }

  // Multi-type: ["string", "integer"]
  const rawType = s.type;
  if (Array.isArray(rawType)) {
    const tsTypes = rawType.map((t) => mapPrimitive(t, s));
    return tsTypes.join(" | ");
  }

  // Enum → string literal union
  if (s.enum && s.enum.length > 0) {
    return s.enum.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v))).join(" | ");
  }

  const typ = rawType as string | undefined;

  if (typ === "array") {
    const itemsResolved = resolveSchema(s.items ?? {});
    // If array items are a dynamic dict, the PHP API may serialize as
    // either a JSON object or JSON array unpredictably
    if (isDynamicDict(itemsResolved)) {
      return "Record<string, any> | any[]";
    }
    const itemType = schemaToTS(s.items ?? {}, parentName + "Item", depth);
    // Wrap complex types in parens
    if (itemType.includes("|") || itemType.includes("&")) {
      return `(${itemType})[]`;
    }
    return `${itemType}[]`;
  }

  if (typ === "object" || (!typ && s.properties)) {
    // Dynamic dict detection: all-numeric keys → Record<string, T>
    if (s.properties && Object.keys(s.properties).length > 0 && isDynamicDict(s)) {
      const valType = dynamicDictValueType(s, parentName, depth);
      return `Record<string, ${valType}>`;
    }
    if (s.properties && Object.keys(s.properties).length > 0) {
      return buildInlineInterface(s, parentName, depth);
    }
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valType = schemaToTS(s.additionalProperties, parentName + "Value", depth);
      return `Record<string, ${valType}>`;
    }
    return "Record<string, unknown>";
  }

  if (typ === "string" && s.format === "binary") {
    return "Blob | Uint8Array";
  }

  return mapPrimitive(typ, s);
}

function mapPrimitive(typ: string | undefined, s?: SchemaObject): string {
  switch (typ) {
    case "string":
      if (s?.format === "binary") return "Blob | Uint8Array";
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function buildInlineInterface(
  s: SchemaObject,
  name: string,
  depth: number
): string {
  const indent = "  ".repeat(depth + 1);
  const closingIndent = "  ".repeat(depth);
  const lines: string[] = ["{"];
  for (const [propName, propSchema] of Object.entries(s.properties ?? {})) {
    const resolved = resolveSchema(propSchema);
    // Apply field type overrides for known API mismatches
    let tsType: string;
    if (propName in FIELD_TYPE_OVERRIDES) {
      tsType = FIELD_TYPE_OVERRIDES[propName];
    } else {
      tsType = schemaToTS(propSchema, name + toPascalCase(propName), depth + 1);
    }
    const desc = resolved.description || propSchema.description;
    if (desc) {
      lines.push(`${indent}/** ${escapeComment(desc)} */`);
    }
    lines.push(`${indent}${safePropName(cleanParamName(propName))}?: ${tsType};`);
  }
  lines.push(`${closingIndent}}`);
  return lines.join("\n");
}

function escapeComment(s: string): string {
  return s.replace(/\*\//g, "*\\/").replace(/\n/g, " ");
}

// ─── Gather all operations ──────────────────────────────────────────────────
interface ParsedOperation {
  path: string;
  method: string; // get, post, etc.
  operationId: string;
  tag: string;
  summary: string;
  description: string;
  pathParams: ParameterObject[];
  queryParams: ParameterObject[];
  requestBody: RequestBodyObject | undefined;
  bodyContentType: string; // "json" | "multipart" | ""
  responseSchema: SchemaObject | undefined;
  hasFileParams: boolean;
  isSearch: boolean;
  isArrayBody: boolean;
  responseIsText: boolean;
}

const operations: ParsedOperation[] = [];

for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
  for (const [httpMethod, rawOp] of Object.entries(pathItem)) {
    if (!rawOp || typeof rawOp !== "object" || !("operationId" in rawOp)) continue;
    const op = rawOp as OperationObject;
    const operationId = op.operationId ?? `${httpMethod}_${pathStr}`;
    const tag = op.tags?.[0] ?? "Default";

    // Resolve parameters
    const allParams = (op.parameters ?? []).map(resolveParam);
    // Also resolve the schema $ref inside each param
    for (const p of allParams) {
      if (p.schema?.$ref) {
        p.schema = resolveSchema(p.schema);
      }
    }

    const pathParams = allParams.filter((p) => p.in === "path");
    const queryParams = allParams.filter((p) => p.in === "query");

    // Request body
    const rb = op.requestBody;
    let bodyContentType = "";
    if (rb?.content) {
      if ("multipart/form-data" in rb.content) {
        bodyContentType = "multipart";
      } else if ("application/json" in rb.content) {
        bodyContentType = "json";
      }
    }

    // Check for file (binary) params in body
    let hasFileParams = false;
    if (bodyContentType === "multipart" && rb?.content?.["multipart/form-data"]?.schema) {
      const bodySchema = resolveSchema(rb.content["multipart/form-data"].schema!);
      for (const prop of Object.values(bodySchema.properties ?? {})) {
        const resolved = resolveSchema(prop);
        if (resolved.format === "binary") {
          hasFileParams = true;
          break;
        }
      }
    }

    // Detect array body (e.g. batch endpoints)
    let isArrayBody = false;
    if (bodyContentType === "json" && rb?.content?.["application/json"]?.schema) {
      const bodySchema = resolveSchema(rb.content["application/json"].schema!);
      if (bodySchema.type === "array") {
        isArrayBody = true;
      }
    }

    // Response schema (200 only)
    let responseSchema: SchemaObject | undefined;
    let responseIsText = false;
    const resp200Raw = op.responses?.["200"];
    if (resp200Raw) {
      const resp200 = resolveResponse(resp200Raw);
      const content = resp200.content;
      if (content?.["text/html"] && !content?.["application/json"]) {
        responseIsText = true;
      } else if (content?.["application/json"]?.schema) {
        responseSchema = content["application/json"].schema;
      }
    }

    // Is this a search endpoint?
    const isSearch = tag.toLowerCase().includes("search") ||
                     pathStr.toLowerCase().includes("/search");

    operations.push({
      path: pathStr,
      method: httpMethod,
      operationId,
      tag,
      summary: op.summary ?? "",
      description: op.description ?? "",
      pathParams,
      queryParams,
      requestBody: rb,
      bodyContentType,
      responseSchema,
      hasFileParams,
      isSearch,
      isArrayBody,
      responseIsText,
    });
  }
}

// ─── Generate types.ts ──────────────────────────────────────────────────────
const typesLines: string[] = [
  "// Auto-generated by codegen/generate.ts — DO NOT EDIT",
  "",
];

// 1) Component schemas
const componentSchemas = spec.components?.schemas ?? {};
for (const [rawName, schema] of Object.entries(componentSchemas)) {
  const tsName = toPascalCase(rawName);
  const resolved = resolveSchema(schema);

  if (resolved.type === "object" || resolved.properties) {
    typesLines.push(`export interface ${tsName} ${buildInlineInterface(resolved, tsName, 0)}`);
    typesLines.push("");
  } else {
    // Simple alias (e.g. UserIDModel -> string | number)
    const tsType = schemaToTS(resolved, tsName);
    typesLines.push(`export type ${tsName} = ${tsType};`);
    typesLines.push("");
  }
}

// 2) Per-operation types: Response, Params, Body
for (const op of operations) {
  const baseName = opIdToTypeName(op.operationId);

  // Response interface
  if (op.responseSchema) {
    const resolved = resolveSchema(op.responseSchema);
    if (resolved.type === "object" || resolved.properties || resolved.$ref) {
      const tsType = schemaToTS(op.responseSchema, baseName + "Response");
      if (tsType.startsWith("{")) {
        typesLines.push(`export interface ${baseName}Response ${tsType}`);
      } else {
        typesLines.push(`export type ${baseName}Response = ${tsType};`);
      }
    } else {
      const tsType = schemaToTS(op.responseSchema, baseName + "Response");
      typesLines.push(`export type ${baseName}Response = ${tsType};`);
    }
    typesLines.push("");
  }

  // Params interface (query params)
  if (op.queryParams.length > 0) {
    typesLines.push(`export interface ${baseName}Params {`);
    for (const param of op.queryParams) {
      const paramSchema = resolveSchema(param.schema);
      const tsType = schemaToParamTS(paramSchema, param, baseName + "Params" + toPascalCase(cleanParamName(param.name)));
      if (param.description) {
        typesLines.push(`  /** ${escapeComment(param.description)} */`);
      }
      typesLines.push(`  ${safePropName(cleanParamName(param.name))}?: ${tsType};`);
    }
    typesLines.push("}");
    typesLines.push("");
  }

  // Body interface
  if (op.requestBody?.content) {
    const ct = op.bodyContentType === "multipart" ? "multipart/form-data" : "application/json";
    const bodySchema = op.requestBody.content[ct]?.schema;
    if (bodySchema) {
      const resolved = resolveSchema(bodySchema);
      // For oneOf bodies, collect all properties from all variants into one flat interface
      if (resolved.oneOf) {
        typesLines.push(`export interface ${baseName}Body {`);
        const seen = new Set<string>();
        for (const variant of resolved.oneOf) {
          const v = resolveSchema(variant);
          for (const [propName, propSchema] of Object.entries(v.properties ?? {})) {
            if (seen.has(propName)) continue;
            seen.add(propName);
            const r = resolveSchema(propSchema);
            const tsType = schemaToTS(propSchema, baseName + "Body" + toPascalCase(propName), 1);
            if (r.description) {
              typesLines.push(`  /** ${escapeComment(r.description)} */`);
            }
            typesLines.push(`  ${safePropName(propName)}?: ${tsType};`);
          }
        }
        typesLines.push("}");
      } else if (resolved.properties) {
        typesLines.push(`export interface ${baseName}Body {`);
        for (const [propName, propSchema] of Object.entries(resolved.properties)) {
          const r = resolveSchema(propSchema);
          let tsType = schemaToTS(propSchema, baseName + "Body" + toPascalCase(propName), 1);
          if (r.description) {
            typesLines.push(`  /** ${escapeComment(r.description)} */`);
          }
          typesLines.push(`  ${safePropName(propName)}?: ${tsType};`);
        }
        typesLines.push("}");
      } else {
        const tsType = schemaToTS(bodySchema, baseName + "Body");
        typesLines.push(`export type ${baseName}Body = ${tsType};`);
      }
      typesLines.push("");
    }
  }
}

function schemaToParamTS(s: SchemaObject, param: ParameterObject, parentName: string): string {
  // deepObject → Record<string, T>
  if (param.style === "deepObject") {
    if (s.additionalProperties && typeof s.additionalProperties === "object") {
      const valType = schemaToTS(s.additionalProperties, parentName + "Value");
      return `Record<string, ${valType}>`;
    }
    return "Record<string, unknown>";
  }
  return schemaToTS(s, parentName);
}

// Write types.ts
fs.writeFileSync(path.join(outputDir, "types.ts"), typesLines.join("\n") + "\n");
console.log(`✓ ${outputDir}/types.ts (${typesLines.length} lines)`);

// ─── Generate client.ts ─────────────────────────────────────────────────────
const clientLines: string[] = [
  "// Auto-generated by codegen/generate.ts — DO NOT EDIT",
  "",
];

// Collect which type names are actually used
const usedTypeNames = new Set<string>();

// Group operations by tag
const tagGroups = new Map<string, ParsedOperation[]>();
for (const op of operations) {
  const group = tagGroups.get(op.tag) ?? [];
  group.push(op);
  tagGroups.set(op.tag, group);
}

// Pre-compute type names to know which imports we need
for (const op of operations) {
  const baseName = opIdToTypeName(op.operationId);
  if (op.responseSchema) usedTypeNames.add(baseName + "Response");
  if (op.queryParams.length > 0) usedTypeNames.add(baseName + "Params");
  if (op.requestBody?.content) {
    const ct = op.bodyContentType === "multipart" ? "multipart/form-data" : "application/json";
    if (op.requestBody.content[ct]?.schema) {
      usedTypeNames.add(baseName + "Body");
    }
  }
}

// Import types
clientLines.push(`import type {`);
for (const name of [...usedTypeNames].sort()) {
  clientLines.push(`  ${name},`);
}
clientLines.push(`} from "./types.js";`);
clientLines.push("");

// RequestFn type
clientLines.push(`export type RequestFn = (method: string, path: string, options?: {`);
clientLines.push(`  params?: Record<string, unknown>;`);
clientLines.push(`  json?: Record<string, unknown> | unknown[];`);
clientLines.push(`  data?: Record<string, unknown>;`);
clientLines.push(`  files?: Record<string, Blob | Uint8Array>;`);
clientLines.push(`  isSearch?: boolean;`);
clientLines.push(`}) => Promise<Record<string, unknown>>;`);
clientLines.push("");

// Build sub-group classes
for (const [tag, ops] of tagGroups) {
  const className = `${apiName}${toPascalCase(tag)}Group`;
  clientLines.push(`class ${className} {`);
  clientLines.push(`  private _request: RequestFn;`);
  clientLines.push(`  constructor(request: RequestFn) { this._request = request; }`);
  clientLines.push("");

  for (const op of ops) {
    const baseName = opIdToTypeName(op.operationId);
    const methodName = safeIdentifier(operationIdToMethod(op.operationId));
    const responseType = op.responseIsText ? "string" : (op.responseSchema ? `${baseName}Response` : "Record<string, unknown>");
    const hasParams = op.queryParams.length > 0;
    const hasBody = !!op.requestBody?.content;
    const ct = op.bodyContentType === "multipart" ? "multipart/form-data" : "application/json";
    const hasBodySchema = hasBody && !!op.requestBody!.content![ct]?.schema;

    // JSDoc
    const jsdocLines: string[] = [];
    if (op.summary) jsdocLines.push(op.summary);
    if (op.description) {
      if (jsdocLines.length > 0) jsdocLines.push("");
      for (const line of op.description.split("\n")) {
        jsdocLines.push(line);
      }
    }
    jsdocLines.push("");
    jsdocLines.push(`@http ${op.method.toUpperCase()} ${op.path}`);

    clientLines.push(`  /**`);
    for (const line of jsdocLines) {
      clientLines.push(`   * ${line}`);
    }
    clientLines.push(`   */`);

    // Build function signature
    const sigParts: string[] = [];
    // Path params as explicit args
    for (const pp of op.pathParams) {
      const paramSchema = resolveSchema(pp.schema);
      const tsType = schemaToTS(paramSchema, baseName + toPascalCase(pp.name));
      sigParts.push(`${safeIdentifier(pp.name)}: ${tsType}`);
    }
    if (hasParams) {
      sigParts.push(`params?: ${baseName}Params`);
    }
    if (op.isArrayBody) {
      sigParts.push(`jobs: Array<{ id?: string; uri: string; method?: string; params?: Record<string, string> }>`);
    } else if (hasBodySchema) {
      sigParts.push(`body?: ${baseName}Body`);
    }

    clientLines.push(
      `  async ${methodName}(${sigParts.join(", ")}): Promise<${responseType}> {`
    );

    // Build path string with interpolation
    const pathExpr = buildPathExpr(op.path, op.pathParams);
    clientLines.push(`    const path = ${pathExpr};`);

    // Build options
    clientLines.push(`    const options: Record<string, unknown> = {};`);

    // Query params serialization
    if (hasParams) {
      clientLines.push(`    if (params) {`);
      clientLines.push(`      const p: Record<string, unknown> = {};`);
      for (const qp of op.queryParams) {
        const cleaned = cleanParamName(qp.name);
        const propAccess = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(cleaned)
          ? `params.${cleaned}`
          : `params[${JSON.stringify(cleaned)}]`;
        const resolved = resolveSchema(qp.schema);
        const isDeepObject = qp.style === "deepObject";
        const isArray = resolved.type === "array";
        const isBoolean = resolved.type === "boolean";
        const sendName = qp.name; // Keep original name including []

        if (isDeepObject) {
          // deepObject: key[sub]=value
          clientLines.push(`      if (${propAccess} !== undefined) {`);
          clientLines.push(`        for (const [k, v] of Object.entries(${propAccess} as Record<string, unknown>)) {`);
          clientLines.push(`          if (v !== undefined) p[\`${cleaned}[\${k}]\`] = v;`);
          clientLines.push(`        }`);
          clientLines.push(`      }`);
        } else if (isBoolean) {
          clientLines.push(`      if (${propAccess} !== undefined) p[${JSON.stringify(sendName)}] = ${propAccess} ? "1" : "0";`);
        } else {
          clientLines.push(`      if (${propAccess} !== undefined) p[${JSON.stringify(sendName)}] = ${propAccess};`);
        }
      }
      clientLines.push(`      options.params = p;`);
      clientLines.push(`    }`);
    }

    // Body serialization
    if (op.isArrayBody) {
      clientLines.push(`    options.json = jobs;`);
    } else if (hasBodySchema) {
      if (op.bodyContentType === "multipart") {
        // Multipart: separate files from data
        clientLines.push(`    if (body) {`);
        clientLines.push(`      const data: Record<string, unknown> = {};`);
        clientLines.push(`      const files: Record<string, Blob | Uint8Array> = {};`);

        const bodySchemaRaw = op.requestBody!.content!["multipart/form-data"]!.schema!;
        const bodySchema = resolveSchema(bodySchemaRaw);
        for (const [propName, propSchemaRaw] of collectAllBodyProps(bodySchema)) {
          const propSchema = resolveSchema(propSchemaRaw);
          const propAccess = `body.${safeIdentifier(propName)}`;
          if (propSchema.format === "binary") {
            clientLines.push(`      if (${propAccess} !== undefined) files[${JSON.stringify(propName)}] = ${propAccess} as Blob | Uint8Array;`);
          } else if (propSchema.type === "boolean") {
            clientLines.push(`      if (${propAccess} !== undefined) data[${JSON.stringify(propName)}] = ${propAccess} ? "1" : "0";`);
          } else {
            clientLines.push(`      if (${propAccess} !== undefined) data[${JSON.stringify(propName)}] = ${propAccess};`);
          }
        }
        clientLines.push(`      if (Object.keys(data).length > 0) options.data = data;`);
        clientLines.push(`      if (Object.keys(files).length > 0) options.files = files;`);
        clientLines.push(`    }`);
      } else {
        // JSON body
        clientLines.push(`    if (body) {`);
        clientLines.push(`      const json: Record<string, unknown> = {};`);

        const bodySchemaRaw = op.requestBody!.content!["application/json"]!.schema!;
        const bodySchema = resolveSchema(bodySchemaRaw);
        const allProps = collectAllBodyProps(bodySchema);
        for (const [propName, propSchemaRaw] of allProps) {
          const propSchema = resolveSchema(propSchemaRaw);
          const safeAccess = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(propName)
            ? `body.${propName}`
            : `body[${JSON.stringify(propName)}]`;
          if (propSchema.type === "boolean") {
            clientLines.push(`      if (${safeAccess} !== undefined) json[${JSON.stringify(propName)}] = ${safeAccess} ? "1" : "0";`);
          } else {
            clientLines.push(`      if (${safeAccess} !== undefined) json[${JSON.stringify(propName)}] = ${safeAccess};`);
          }
        }
        clientLines.push(`      if (Object.keys(json).length > 0) options.json = json;`);
        clientLines.push(`    }`);
      }
    }

    if (op.isSearch) {
      clientLines.push(`    options.isSearch = true;`);
    }

    if (op.responseIsText) {
      clientLines.push(
        `    const resp = await this._request(${JSON.stringify(op.method.toUpperCase())}, path, options);`
      );
      clientLines.push(`    return (resp as any)?._raw ?? String(resp ?? "");`);
    } else {
      clientLines.push(
        `    return this._request(${JSON.stringify(op.method.toUpperCase())}, path, options) as Promise<${responseType}>;`
      );
    }
    clientLines.push(`  }`);
    clientLines.push("");
  }

  clientLines.push("}");
  clientLines.push("");
}

// Helper to collect all body properties, including from oneOf variants
function collectAllBodyProps(schema: SchemaObject): [string, SchemaObject][] {
  const result: [string, SchemaObject][] = [];
  const seen = new Set<string>();
  if (schema.oneOf) {
    for (const variant of schema.oneOf) {
      const v = resolveSchema(variant);
      for (const [name, prop] of Object.entries(v.properties ?? {})) {
        if (!seen.has(name)) {
          seen.add(name);
          result.push([name, prop]);
        }
      }
    }
  } else if (schema.properties) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      result.push([name, prop]);
    }
  }
  return result;
}

// Main client class
clientLines.push(`export class ${apiName}Client {`);
for (const [tag] of tagGroups) {
  const groupName = tagToGroupName(tag);
  const className = `${apiName}${toPascalCase(tag)}Group`;
  clientLines.push(`  readonly ${safeIdentifier(groupName)}: ${className};`);
}
clientLines.push("");
clientLines.push(`  constructor(request: RequestFn) {`);
for (const [tag] of tagGroups) {
  const groupName = tagToGroupName(tag);
  const className = `${apiName}${toPascalCase(tag)}Group`;
  clientLines.push(`    this.${safeIdentifier(groupName)} = new ${className}(request);`);
}
clientLines.push(`  }`);
clientLines.push("}");
clientLines.push("");

function buildPathExpr(pathStr: string, pathParams: ParameterObject[]): string {
  if (pathParams.length === 0) return JSON.stringify(pathStr);
  // Replace {param} with ${param}
  let expr = pathStr;
  for (const pp of pathParams) {
    expr = expr.replace(`{${pp.name}}`, `\${encodeURIComponent(String(${safeIdentifier(pp.name)}))}`);
  }
  return "`" + expr + "`";
}

fs.writeFileSync(path.join(outputDir, "client.ts"), clientLines.join("\n") + "\n");
console.log(`✓ ${outputDir}/client.ts (${clientLines.length} lines)`);
console.log(`✓ Done generating ${apiName} API (${operations.length} operations)`);
