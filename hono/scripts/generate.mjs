import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const generated = resolve(root, 'hono/src/generated');
const document = JSON.parse(await readFile(resolve(root, 'schema/typesafe.openapi.json'), 'utf8'));
const annotations = new Set(['title', 'description', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly', '$comment', 'discriminator']);
const scalarKeywords = new Set(['type', 'required', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern']);
const schemas = new Set(['additionalProperties', 'unevaluatedProperties', 'items', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);

function containsNumber(value) {
  if (typeof value === 'number') return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsNumber);
}

// Projection in codec.ts is sound ONLY while the schema can observe numeric
// TYPE, not numeric value or equality. Unknown keywords fail closed rather than
// letting a schema update silently weaken validation. Annotations are inert.
function guardedSchema(schema, path) {
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`Invalid schema at ${path}`);
  const result = Object.create(null);
  for (const [keyword, value] of Object.entries(schema)) {
    if (annotations.has(keyword)) continue;
    if (scalarKeywords.has(keyword)) result[keyword] = value;
    else if (keyword === '$ref') {
      if (typeof value !== 'string' || !value.startsWith('#/components/schemas/')) throw new Error(`Unsupported schema reference at ${path}`);
      result[keyword] = value.replace('#/components/schemas/', '#/$defs/');
    } else if (keyword === 'const' || keyword === 'enum') {
      if (containsNumber(value)) throw new Error(`Numeric ${keyword} invalidates lossless type projection at ${path}`);
      result[keyword] = value;
    } else if (schemas.has(keyword)) result[keyword] = guardedSchema(value, `${path}/${keyword}`);
    else if (schemaArrays.has(keyword)) result[keyword] = value.map((child, index) => guardedSchema(child, `${path}/${keyword}/${index}`));
    else if (schemaMaps.has(keyword)) result[keyword] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, guardedSchema(child, `${path}/${keyword}/${name}`)]));
    else throw new Error(`Unsupported schema keyword ${keyword} at ${path}; review lossless numeric projection before enabling it`);
  }
  return result;
}

const definitions = Object.fromEntries(Object.entries(document.components.schemas).map(([name, schema]) => [name, guardedSchema(schema, name)]));
const schemaID = 'https://one-system.invalid/typesafe.openapi.json';
const ajv = new Ajv2020({
  strict: true, strictTypes: false, allErrors: false, ownProperties: true,
  code: { source: true, esm: true },
});
ajv.addSchema({ $id: schemaID, $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: definitions });
const validators = {
  validateRequest: `${schemaID}#/$defs/SystemOneRequest`,
  validateResponse: `${schemaID}#/$defs/SystemOneResponse`,
  validateModels: `${schemaID}#/$defs/ModelMetadataList`,
};
const validatorCode = standaloneCode(ajv, validators);
await mkdir(generated, { recursive: true });
await writeFile(resolve(generated, 'validators.js'), '// Generated from the authoritative OpenAPI schema; do not edit.\n' + validatorCode + '\n');
await writeFile(resolve(generated, 'validators.d.ts'), Object.keys(validators).map(name => `export declare function ${name}(value: unknown): boolean;`).join('\n') + '\n');

const template = await readFile(resolve(root, 'contract/backend-selection.question.json'), 'utf8');
// No secret or environment binding is needed to build. The default asset is
// public synthetic data. A deployment can optionally bundle its own registry
// and referenced questions by setting ONE_SYSTEM_WORKER_CONFIG at build time.
// This is a file path; references inside it resolve against repository cwd,
// exactly as Go does when launched from the repository root.
const assets = new Map([
  ['examples/routing.questions.json', await readFile(resolve(root, 'examples/routing.questions.json'), 'utf8')],
]);
let registry = null;
if (process.env.ONE_SYSTEM_WORKER_CONFIG) {
  registry = await readFile(resolve(process.cwd(), process.env.ONE_SYSTEM_WORKER_CONFIG), 'utf8');
  const config = JSON.parse(registry);
  if (config.selection?.questions_file) {
    const name = config.selection.questions_file;
    assets.set(name, await readFile(resolve(root, name), 'utf8'));
  }
}
// Export raw TEXT, never a JS literal containing the parsed request/asset data.
// __proto__ and every numeric lexeme therefore survive bundling unchanged.
await writeFile(resolve(generated, 'assets.ts'),
  `// Generated public/configuration assets; secrets belong in runtime bindings.\n` +
  `export const backendSelectionQuestion = ${JSON.stringify(template)};\n` +
  `export const bundledRegistry: string | null = ${JSON.stringify(registry)};\n` +
  `export const bundledQuestions: ReadonlyMap<string, string> = new Map(${JSON.stringify([...assets])});\n`);
