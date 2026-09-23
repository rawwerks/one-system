/**
 * Generated System One questions: tell the generator the official shape and the
 * target route's limits, then check both deterministically before use.
 * Application code owns `model` and `state`; a generator writes only `questions`.
 */
import { readFileSync } from 'node:fs';
import { validateRequest } from '../hono/src/generated/validators.js';
import { generateChecked, parseJson, Rejected, type Generate } from './generate.mts';
import type { Component, Scope } from './runtime.mts';
import type { Capabilities, Questions } from './system-one.mts';

type Schema = Record<string, unknown>;

/** The Questions schema from the pinned OpenAPI description, as a standalone JSON Schema. */
export function questionsSchema(): Schema {
  const openapi = JSON.parse(readFileSync(new URL('../schema/typesafe.openapi.json', import.meta.url), 'utf8'));
  const components = openapi.components.schemas as Record<string, Schema>;
  const defs: Record<string, Schema> = {};
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) {
        const name = child.slice('#/components/schemas/'.length);
        if (!(name in defs)) { defs[name] = {}; defs[name] = rewrite(components[name]) as Schema; }
        return [key, `#/$defs/${name}`];
      }
      return [key, rewrite(child)];
    }));
  };
  const root = rewrite((components.SystemOneRequest!.properties as Schema).questions) as Schema;
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...root, $defs: defs };
}

const criteriaCount = (criteria: unknown) =>
  Array.isArray(criteria) ? criteria.length : criteria && typeof criteria === 'object' ? Object.keys(criteria).length : 0;

/** Problems a backend's declared limits find, mirroring the gateway's own check. */
function limitProblems(questions: Questions, limits: Capabilities): string[] {
  const problems: string[] = [];
  const ids = Object.keys(questions);
  if (limits.max_questions !== undefined && ids.length > limits.max_questions) problems.push(`at most ${limits.max_questions} questions`);
  for (const id of ids) {
    const { type, criteria } = questions[id]!;
    if (limits.question_types && !limits.question_types.includes(type)) {
      problems.push(`questions.${id}: type ${type} is not accepted; use ${limits.question_types.join(', ')}`);
      continue;
    }
    if (type === 'noul') continue;
    const count = criteriaCount(criteria);
    if (limits.min_criteria !== undefined && count < limits.min_criteria) problems.push(`questions.${id}: needs at least ${limits.min_criteria} criteria`);
    if (limits.max_criteria !== undefined && count > limits.max_criteria) problems.push(`questions.${id}: allows at most ${limits.max_criteria} criteria`);
  }
  return problems;
}

/**
 * Problems in the questions that would make the gateway reject them for a route,
 * or [] when they are acceptable. `route` comes from routeCapabilities: the
 * request passes when any backend accepts it, and an undeclared backend is unknown.
 * Pass `structuredState: true` when the state you will send is not a string, so
 * backends declared `structured_state: false` are excluded. The gateway's own
 * selector limits on automatic routes are not modelled here.
 */
export function questionProblems(value: unknown, route: readonly (Capabilities | null)[] = [null], structuredState = false): string[] {
  // Generators often wrap the answer as {"questions": {...}}; say so plainly.
  const inner = (value as { questions?: unknown } | null)?.questions;
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && inner && typeof inner === 'object' && !Array.isArray(inner)
      && Object.values(inner).some(question => ['choice', 'noul', 'score'].includes((question as { type?: unknown })?.type as string))) {
    return ['return the questions object itself, mapping question IDs to questions, not wrapped in a "questions" key'];
  }
  // An unknown type would otherwise surface as every branch's oneOf mismatch.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const unknown = Object.entries(value).filter(([, question]) => !['choice', 'noul', 'score'].includes((question as { type?: unknown })?.type as string));
    if (unknown.length) return unknown.map(([id]) => `questions.${id}.type: must be one of choice, noul, score`);
  }
  // The gateway's own validator, generated from the same pinned schema.
  if (!validateRequest({ model: 'check', state: '', questions: value })) {
    const errors = (validateRequest as unknown as { errors?: { instancePath: string; message?: string }[] }).errors ?? [];
    const lines = [...new Set(errors.map(error => `${error.instancePath.replace(/^\//, '').replaceAll('/', '.') || 'questions'}: ${error.message ?? 'is invalid'}`))];
    // Keep the specific reasons; the other type branches' const/oneOf mismatches only add noise.
    const specific = lines.filter(line => !/must be equal to constant|must match exactly one schema in oneOf/.test(line));
    return specific.length ? specific : lines;
  }
  const questions = value as Questions;
  route = route.filter(limits => !(structuredState && limits?.structured_state === false));
  if (!route.length) return ['no backend on this route accepts structured (non-string) state'];
  if (route.some(limits => limits === null)) return [];
  const perBackend = route.map(limits => limitProblems(questions, limits!));
  if (perBackend.some(problems => problems.length === 0)) return [];
  return perBackend.length === 1 ? perBackend[0]! : perBackend.map((problems, i) => `backend ${i + 1}: ${problems.join('; ')}`);
}

const guidance = readFileSync(new URL('./question-guidance.md', import.meta.url), 'utf8');

function routeRules(route: readonly (Capabilities | null)[]): string {
  if (route.some(limits => limits === null)) return '';
  const describe = (limits: Capabilities) => [
    limits.question_types && `question types: ${limits.question_types.join(', ')}`,
    limits.max_questions !== undefined && `at most ${limits.max_questions} questions`,
    limits.min_criteria !== undefined && `choice/score criteria: at least ${limits.min_criteria}`,
    limits.max_criteria !== undefined && `choice/score criteria: at most ${limits.max_criteria}`,
  ].filter(Boolean).join('; ');
  const lines = route.map(limits => describe(limits!)).filter(Boolean);
  if (!lines.length) return '';
  return lines.length === 1
    ? `The destination accepts only: ${lines[0]}.`
    : `The destination accepts the request if it fits any one of these:\n${lines.map(line => `- ${line}`).join('\n')}`;
}

export interface QuestionAuthorOptions {
  /** From routeCapabilities(connection, model). Omit when the destination is unknown. */
  readonly route?: readonly (Capabilities | null)[];
  readonly attempts?: number;
  /** True when the state you will send with these questions is not a string. */
  readonly structuredState?: boolean;
  /** Optional semantic review, e.g. System One judging question quality. Throw Rejected. */
  readonly verify?: (questions: Questions, scope: Scope) => Promise<void>;
}

/** A component that turns a task description into checked System One questions. */
export function questionAuthor(name: string, generate: Generate, options: QuestionAuthorOptions = {}): Component<string, Questions> {
  const route = options.route ?? [null];
  const rules = routeRules(route);
  return generateChecked<Questions>(name, generate, {
    decode(text) {
      const value = parseJson(text);
      const problems = questionProblems(value, route, options.structuredState);
      if (problems.length) throw new Rejected(problems.join('; '));
      return value as Questions;
    },
    verify: options.verify,
  }, {
    attempts: options.attempts ?? 3,
    system: rules ? `${guidance}\n${rules}` : guidance,
    responseSchema: questionsSchema(),
  });
}
