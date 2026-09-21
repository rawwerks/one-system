import { encodeObject, finiteFloat, object, parseJSON, raw, signedInteger, text, validationView } from './codec.js';
import type { JsonNode, JsonObject } from './codec.js';
import { validateRequest } from './generated/validators.js';

export interface BackendLimits {
  readonly maxCharacters?: bigint;
  readonly maxNonASCIILetterFraction?: number;
  readonly maxQuestions?: bigint;
  readonly maxCriteria?: bigint;
}
export interface Backend {
  readonly id: string;
  readonly baseURL: string;
  readonly model: string;
  readonly description: string;
  readonly key: string;
  readonly limits?: BackendLimits;
  readonly capabilities?: Capabilities;
}
export interface Capabilities {
  readonly questionTypes: readonly string[];
  readonly maxQuestions?: bigint;
  readonly minCriteria?: bigint;
  readonly maxCriteria?: bigint;
  readonly structuredState?: boolean;
  readonly json: string;
}
export interface SelectionRule { readonly question: string; readonly choice: string; readonly above: number }
export interface FeatureSelection {
  readonly questions: JsonObject;
  readonly escalateTo: string;
  readonly rules: readonly SelectionRule[];
}
export interface GatewayConfig {
  readonly name: string;
  readonly publicKey: string;
  readonly selector: string;
  readonly fallback: string;
  readonly escalationConfidence: number;
  readonly selection?: FeatureSelection;
  readonly backends: ReadonlyMap<string, Backend>;
}
export interface ConfigDependencies {
  readonly publicKey: string;
  readonly secret: (name: string) => string | undefined;
  // Node supplies bounded filesystem reads; Workers supply explicitly bundled
  // or bound JSON assets. Core configuration never inspects process or files.
  readonly questions: (name: string) => Promise<string> | string;
}
export const CONFIG_LIMIT = 1 << 20;
const encoder = new TextEncoder();

export function validKey(key: string | undefined): key is string {
  return key !== undefined && key !== '' && !/[ \t\r\n]/.test(key);
}

function fields(node: JsonNode | undefined, names: readonly string[]): Map<string, JsonNode> {
  const result = new Map<string, JsonNode>();
  if (node === undefined || node.kind === 'null') return result;
  // encoding/json's struct decoder accepts case-insensitive field spelling.
  for (const [name, value] of object(node).fields) {
    const field = name.toLowerCase();
    if (!names.includes(field)) throw new Error('Backend configuration contains an unknown field');
    result.set(field, value);
  }
  return result;
}

function stringField(node: JsonNode | undefined): string {
  return node === undefined || node.kind === 'null' ? '' : text(node);
}

function integerLimit(node: JsonNode | undefined, minimum: bigint, name: string): bigint | undefined {
  if (node === undefined || node.kind === 'null') return undefined;
  const value = signedInteger(node);
  if (value < minimum) throw new Error(`Invalid backend ${name}`);
  return value;
}

function baseURL(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid backend base_url'); }
  const authority = /^(https?):\/\/([^/?#]*)/.exec(input);
  if (!authority || !url.host || url.username || url.password || authority[2]!.includes('@') || url.search || url.hash) {
    throw new Error('Backend base_url must use HTTP(S) without credentials, query, or fragment');
  }
  if (authority[1] === 'http') {
    const host = authority[2]!.startsWith('[')
      ? authority[2]!.slice(1, authority[2]!.indexOf(']'))
      : authority[2]!.split(':')[0]!;
    const ipv4 = host.split('.');
    const loopback4 = ipv4.length === 4 && ipv4.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255) && ipv4[0] === '127';
    const loopback6 = host.includes(':') && !host.includes('%') &&
      (url.hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(url.hostname));
    if (host !== 'localhost' && !loopback4 && !loopback6) {
      throw new Error('Backend base_url requires HTTPS except for loopback hosts');
    }
  }
  return input.replace(/\/+$/, '');
}

export async function loadConfig(source: string, dependencies: ConfigDependencies): Promise<GatewayConfig> {
  if (!validKey(dependencies.publicKey)) throw new Error('ONE_SYSTEM_API_KEY must contain a nonempty bearer key without whitespace');
  if (encoder.encode(source).byteLength > CONFIG_LIMIT) throw new Error('Backend configuration exceeds 1 MiB');
  const registry = fields(parseJSON(source), ['name', 'selector', 'fallback', 'escalation_confidence', 'selection', 'backends']);
  const name = stringField(registry.get('name'));
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Configuration name must be a nonempty ASCII identifier');
  const backendList = registry.get('backends');
  if (backendList?.kind !== 'array' || backendList.items.length === 0) throw new Error('Backend configuration requires at least one backend');
  const backends = new Map<string, Backend>();
  for (const node of backendList.items) {
    const b = fields(node, ['id', 'base_url', 'model', 'api_key_env', 'description', 'limits', 'capabilities']);
    const id = stringField(b.get('id'));
    const model = stringField(b.get('model'));
    const description = stringField(b.get('description'));
    const keyName = stringField(b.get('api_key_env'));
    if (!id || !model || !description || !keyName) throw new Error('Every backend requires id, model, description, and api_key_env');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid backend ID');
    if (id === name) throw new Error('Backend ID must differ from the configuration name');
    if (backends.has(id)) throw new Error('Backend IDs must be unique');
    const key = dependencies.secret(keyName);
    if (!validKey(key)) throw new Error('A backend api_key_env must reference a nonempty bearer key without whitespace');
    const url = baseURL(stringField(b.get('base_url')));
    let limits: BackendLimits | undefined;
    if (b.has('limits') && b.get('limits')!.kind !== 'null') {
      const l = fields(b.get('limits'), ['max_characters', 'max_non_ascii_letter_fraction', 'max_questions', 'max_criteria']);
      const maxCharacters = integerLimit(l.get('max_characters'), 1n, 'max_characters');
      const maxQuestions = integerLimit(l.get('max_questions'), 1n, 'max_questions');
      const maxCriteria = integerLimit(l.get('max_criteria'), 2n, 'max_criteria');
      const fraction = l.get('max_non_ascii_letter_fraction');
      const maxNonASCIILetterFraction = fraction === undefined || fraction.kind === 'null' ? undefined : finiteFloat(fraction);
      if (maxNonASCIILetterFraction !== undefined && (maxNonASCIILetterFraction < 0 || maxNonASCIILetterFraction > 1)) throw new Error('Invalid backend max_non_ascii_letter_fraction');
      limits = {
        ...(maxCharacters === undefined ? {} : { maxCharacters }),
        ...(maxQuestions === undefined ? {} : { maxQuestions }),
        ...(maxCriteria === undefined ? {} : { maxCriteria }),
        ...(maxNonASCIILetterFraction === undefined ? {} : { maxNonASCIILetterFraction }),
      };
    }
    let capabilities: Capabilities | undefined;
    const capabilityNode = b.get('capabilities');
    if (capabilityNode !== undefined && capabilityNode.kind !== 'null') {
      const c = fields(capabilityNode, ['question_types', 'max_questions', 'min_criteria', 'max_criteria', 'structured_state']);
      const types = c.get('question_types');
      if (types?.kind !== 'array' || types.items.length === 0) throw new Error('Capabilities require nonempty question_types');
      const questionTypes = types.items.map(text);
      if (new Set(questionTypes).size !== questionTypes.length || questionTypes.some(kind => !['choice', 'score', 'noul'].includes(kind))) throw new Error('Capabilities require unique native question types');
      const maxQuestions = integerLimit(c.get('max_questions'), 1n, 'max_questions');
      const minCriteria = integerLimit(c.get('min_criteria'), 1n, 'min_criteria');
      const maxCriteria = integerLimit(c.get('max_criteria'), 1n, 'max_criteria');
      if (minCriteria !== undefined && maxCriteria !== undefined && minCriteria > maxCriteria) throw new Error('min_criteria must not exceed max_criteria');
      const structured = c.get('structured_state');
      if (structured !== undefined && structured.kind !== 'null' && structured.kind !== 'boolean') throw new Error('structured_state must be a boolean');
      const structuredState = structured?.kind === 'boolean' ? structured.value : undefined;
      const entries: [string, string][] = [['question_types', JSON.stringify(questionTypes)]];
      for (const [name, value] of [['max_questions', maxQuestions], ['min_criteria', minCriteria], ['max_criteria', maxCriteria]] as const) {
        if (value !== undefined) entries.push([name, String(value)]);
      }
      if (structuredState !== undefined) entries.push(['structured_state', String(structuredState)]);
      capabilities = {
        questionTypes, json: encodeObject(entries),
        ...(maxQuestions === undefined ? {} : { maxQuestions }),
        ...(minCriteria === undefined ? {} : { minCriteria }),
        ...(maxCriteria === undefined ? {} : { maxCriteria }),
        ...(structuredState === undefined ? {} : { structuredState }),
      };
    }
    backends.set(id, { id, model, description, key, baseURL: url, ...(limits === undefined ? {} : { limits }), ...(capabilities === undefined ? {} : { capabilities }) });
  }
  const selector = stringField(registry.get('selector'));
  const fallback = stringField(registry.get('fallback'));
  if (!backends.has(selector)) throw new Error('Selector must name a configured backend ID');
  if (fallback && !backends.has(fallback)) throw new Error('Fallback must name a configured backend ID');
  const confidenceNode = registry.get('escalation_confidence');
  const escalationConfidence = finiteFloat(confidenceNode);
  if (confidenceNode !== undefined && confidenceNode.kind !== 'null' && !fallback) throw new Error('escalation_confidence requires a fallback backend ID');
  if (escalationConfidence < 0 || escalationConfidence > 1) throw new Error('escalation_confidence must fall between 0 and 1');
  let selection: FeatureSelection | undefined;
  const selectionNode = registry.get('selection');
  if (selectionNode !== undefined && selectionNode.kind !== 'null') {
    const s = fields(selectionNode, ['questions_file', 'escalate_to', 'rules']);
    if (!fallback) throw new Error('Selection requires a fallback backend ID');
    const escalateTo = stringField(s.get('escalate_to'));
    if (!backends.has(escalateTo)) throw new Error('Selection escalate_to must name a configured backend ID');
    if (escalateTo === fallback) throw new Error('Selection escalate_to must differ from the fallback backend');
    const ruleNodes = s.get('rules');
    if (ruleNodes?.kind !== 'array' || ruleNodes.items.length === 0) throw new Error('Selection requires at least one rule');
    const questionsSource = await dependencies.questions(stringField(s.get('questions_file')));
    if (encoder.encode(questionsSource).byteLength > CONFIG_LIMIT) throw new Error('Selection questions_file exceeds 1 MiB');
    const questions = object(parseJSON(questionsSource));
    if (questions.fields.size === 0) throw new Error('Selection questions_file must contain a SystemOne questions object');
    if (!validateRequest(validationView(parseJSON(encodeObject([
      ['model', JSON.stringify(name)], ['state', '{}'], ['questions', raw(questions)],
    ]))))) throw new Error('Selection questions_file must contain valid SystemOne questions');
    const rules: SelectionRule[] = [];
    for (const ruleNode of ruleNodes.items) {
      const rule = fields(ruleNode, ['question', 'choice', 'above']);
      const question = stringField(rule.get('question'));
      const choice = stringField(rule.get('choice'));
      const above = finiteFloat(rule.get('above'));
      if (!questions.fields.has(question)) throw new Error('Every selection rule must name a question from questions_file');
      const definition = object(questions.fields.get(question));
      if (text(definition.fields.get('type')) === 'choice' && !object(definition.fields.get('criteria')).fields.has(choice)) {
        throw new Error('Every Choice selection rule must name a configured criterion');
      }
      if (above < 0 || above > 1) throw new Error('Every selection rule threshold must fall between 0 and 1');
      rules.push({ question, choice, above });
    }
    selection = { questions, escalateTo, rules };
  }
  return {
    name, publicKey: dependencies.publicKey, selector, fallback, escalationConfidence, backends,
    ...(selection === undefined ? {} : { selection }),
  };
}
