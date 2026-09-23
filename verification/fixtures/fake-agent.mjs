#!/usr/bin/env node
// A stand-in for an agent CLI in print mode: prompt on stdin, answer on stdout.
// FAKE_AGENT_DIR holds replies.json (one reply per invocation) and records each stdin.
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FAKE_AGENT_DIR;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const n = readdirSync(dir).filter(name => name.startsWith('stdin-')).length;
writeFileSync(join(dir, `stdin-${n}.txt`), Buffer.concat(chunks));
appendFileSync(join(dir, 'pids.txt'), `${process.pid}\n`);
const reply = JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8'))[n] ?? { stdout: '' };
if (reply.stderr) process.stderr.write(reply.stderr);
if (reply.sleep) await new Promise(done => setTimeout(done, reply.sleep));
if (reply.bytes) process.stdout.write('x'.repeat(reply.bytes));
process.stdout.write(reply.stdout ?? '', () => process.exit(reply.exit ?? 0));
