/**
 * Example: have your own agent CLI write System One questions, check them against
 * the gateway's route, and optionally ask them about your state.
 *
 *   node examples/generators/author-questions.mts --agent 'claude -p' \
 *     --model local-demo --task 'Detect refund requests and how urgent they are' \
 *     [--state state.json]
 *
 * Reads ONE_SYSTEM_URL (default http://127.0.0.1:8090) and ONE_SYSTEM_API_KEY.
 * The agent keeps its own login, model and subscription; it receives the prompt
 * on stdin and answers on stdout. Only --state sends anything to System One.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { agentCli } from '../../composition/generate.mts';
import { questionAuthor } from '../../composition/questions.mts';
import { run } from '../../composition/runtime.mts';
import { ask, routeCapabilities, type Json } from '../../composition/system-one.mts';

const { values } = parseArgs({ options: {
  agent: { type: 'string' }, model: { type: 'string' }, task: { type: 'string' }, state: { type: 'string' },
  attempts: { type: 'string', default: '3' },
} });
if (!values.agent || !values.model || !values.task || !process.env.ONE_SYSTEM_API_KEY) {
  console.error('Usage: --agent "<cli> <print-mode flags>" --model <route> --task "<what to judge>" [--state file.json]; set ONE_SYSTEM_API_KEY.');
  process.exit(2);
}
const gateway = { endpoint: process.env.ONE_SYSTEM_URL ?? 'http://127.0.0.1:8090', apiKey: process.env.ONE_SYSTEM_API_KEY };
const [command, ...args] = values.agent.split(/\s+/).filter(Boolean);
const author = questionAuthor('questions', agentCli(command!, args), {
  route: await routeCapabilities(gateway, values.model), attempts: Number(values.attempts),
});
const questions = await run(author, values.task, { allow: [], timeoutMs: 600_000 });
console.log(JSON.stringify({ questions }, null, 2));
if (values.state) {
  const state = JSON.parse(readFileSync(values.state, 'utf8')) as Json;
  console.log(JSON.stringify(await ask(gateway, { model: values.model, state, questions }), null, 2));
}
