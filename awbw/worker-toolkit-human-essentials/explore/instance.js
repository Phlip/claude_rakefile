#!/usr/bin/env node
// instance.js — run more than one Explore container of THIS repo at once.
//
// The normal single container is still just `npx @devcontainers/cli up`, and if
// you only want several Claude sessions on the SAME repo state you don't need
// this at all — just open more shells into the one container
// (`npx @devcontainers/cli exec bash`). Use this when you want ANOTHER container
// with its OWN separate working tree — e.g. to explore a different commit / repo
// state at the same time — without unzipping the toolkit again.
//
// Each named instance gets:
//   - its own container (a distinct id-label, so `up` makes a new one),
//   - its own host port(s) (auto-picked free, so nothing collides),
//   - its own repo working tree (initialize.js clones repo<name>, so a
//     `git checkout` in one instance never disturbs another).
//
// Run on the HOST, from the toolkit's explore/ folder (this drives Docker; the
// Explore devcontainer has no Docker socket):
//   node instance.js b           # create/start instance "b", print its URL
//   node instance.js shell b      # open a shell in instance "b"
//   node instance.js stop b       # stop+remove it (keeps the repo clone)
//   node instance.js list         # list running/stopped instances
//
// This is Node (not bash) so it works on Windows without WSL, matching
// initialize.js.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const EXPLORE_DIR = dirname(SCRIPT);
// How the worker invoked us, so the follow-up commands we print match their cwd
// (`node instance.js …` from explore/, or `node explore/instance.js …` from the
// toolkit root) instead of guessing.
const SELF = `node ${relative(process.cwd(), SCRIPT) || 'instance.js'}`;
// Our own id-labels. Passing --id-label REPLACES the devcontainer CLI's default
// identity labels (it drops devcontainer.local_folder / devcontainer.config_file
// entirely), so we set our own and look up by them: ROOT_LABEL scopes to THIS
// toolkit copy (so `list`/`stop` never touch another copy's instances or the
// primary), NAME_LABEL identifies the instance.
const ROOT_LABEL = `raccoon-explore-root=${EXPLORE_DIR}`;
const NAME_LABEL = 'raccoon-explore';
const RESERVED = new Set(['list', 'stop', 'shell', 'help', '--help', '-h']);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

/** Quiet `docker ...` returning trimmed stdout (empty string on any failure). */
function docker(args) {
  try {
    return execSync(`docker ${args}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function readToolkit() {
  for (const p of [join(EXPLORE_DIR, 'toolkit.json'), resolve(EXPLORE_DIR, '..', 'toolkit.json')]) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      /* try next */
    }
  }
  return {};
}

function validName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(name);
}

/**
 * The per-instance working-tree dir name. A polyglot toolkit gives each instance
 * its own `repos<name>` tree (all member repos); a single-repo toolkit a `repo<name>`.
 * initialize.js creates whichever matches, and the devcontainer mount derives the
 * same name from EXPLORE_INSTANCE.
 */
function worktreeName(name, tk) {
  return (tk && tk.polyglot ? 'repos' : 'repo') + name;
}

/** The container id for instance <name> of THIS toolkit, or '' if none. */
function instanceContainer(name) {
  return (
    docker(`ps -aq --filter "label=${ROOT_LABEL}" --filter "label=${NAME_LABEL}=${name}"`)
      .split('\n')
      .filter(Boolean)[0] || ''
  );
}

/** Resolve true once we find a free TCP port on the host at/after `start`. */
function freePort(start) {
  return new Promise((res, rej) => {
    const tryPort = (p) => {
      if (p > start + 500) return rej(new Error(`no free host port near ${start}`));
      const srv = createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => res(p)));
      srv.listen(p, '0.0.0.0');
    };
    tryPort(start);
  });
}

function publishedPort(id, containerPort) {
  const out = docker(`port ${id} ${containerPort}/tcp`);
  const m = out.match(/:(\d+)\s*$/m);
  return m ? m[1] : '';
}

function up(name, env) {
  const r = spawnSync(
    'npx',
    [
      '@devcontainers/cli',
      'up',
      '--workspace-folder',
      EXPLORE_DIR,
      '--id-label',
      ROOT_LABEL,
      '--id-label',
      `${NAME_LABEL}=${name}`,
    ],
    { stdio: 'inherit', env }
  );
  if (r.status !== 0)
    die(`\ninstance "${name}" failed to start (devcontainer up exited ${r.status}).`);
}

function reportUp(name, tk) {
  const id = instanceContainer(name);
  const port = publishedPort(id, 3000);
  console.log(`\n✅ instance "${name}" is up`);
  if (port) console.log(`   open   http://localhost:${port}`);
  console.log(`   shell  ${SELF} shell ${name}      (then run \`run-app\` inside)`);
  if (tk.repo === 'Palolo-031') {
    console.log(`   note   a second Palolo runs fine for exploring, but its browser app calls the`);
    console.log(`          first container's API (the client build bakes in localhost:3001).`);
  }
  console.log(
    `   stop   ${SELF} stop ${name}        (keeps the ${worktreeName(name, tk)} working tree)`
  );
}

async function create(name) {
  if (!validName(name))
    die(`Invalid instance name "${name}". Use letters/digits/hyphens, e.g. b, two, alt2.`);
  const tk = readToolkit();
  const ports = tk.explorePorts || {};

  const existing = instanceContainer(name);
  if (existing) {
    const running = docker(`inspect -f "{{.State.Running}}" ${existing}`) === 'true';
    // Re-up reuses the existing container (and its baked port mapping); pass
    // EXPLORE_INSTANCE so initialize.js's clone step stays a no-op.
    if (!running) up(name, { ...process.env, EXPLORE_INSTANCE: name });
    else console.log(`instance "${name}" is already running.`);
    reportUp(name, tk);
    return;
  }

  // Fresh instance: pick free host port(s) clear of the primary's defaults.
  const env = { ...process.env, EXPLORE_INSTANCE: name };
  const clientBase = (Number(ports.clientHost) || 3000) + 10;
  const clientPort = await freePort(clientBase);
  env.EXPLORE_CLIENT_PORT = String(clientPort);
  if (ports.serverHost) env.EXPLORE_SERVER_PORT = String(await freePort(clientPort + 1));
  // Well clear of the primary's default: this one is published host:container identical,
  // so a collision would silently point the client's livereload at the other container.
  if (ports.livereloadHost)
    env.EXPLORE_LIVERELOAD_PORT = String(await freePort(ports.livereloadHost + 10));
  up(name, env);
  reportUp(name, tk);
}

function shell(name) {
  if (!instanceContainer(name)) die(`No instance "${name}". Create it first: ${SELF} ${name}`);
  const r = spawnSync(
    'npx',
    [
      '@devcontainers/cli',
      'exec',
      '--workspace-folder',
      EXPLORE_DIR,
      '--id-label',
      ROOT_LABEL,
      '--id-label',
      `${NAME_LABEL}=${name}`,
      'bash',
    ],
    { stdio: 'inherit' }
  );
  process.exit(r.status ?? 0);
}

function stop(name) {
  const id = instanceContainer(name);
  if (!id) return console.log(`No instance "${name}" to stop.`);
  docker(`rm -f ${id}`);
  const wt = worktreeName(name, readToolkit());
  console.log(
    `Stopped instance "${name}". Its ${wt} working tree is kept (delete it with: rm -rf ${join(EXPLORE_DIR, wt)}).`
  );
}

function list() {
  const rows = docker(
    `ps -a --filter "label=${ROOT_LABEL}" ` +
      `--format "{{.Label \\"${NAME_LABEL}\\"}}\\t{{.State}}\\t{{.Ports}}"`
  );
  if (!rows) return console.log(`No extra instances. Create one with: ${SELF} <name>`);
  console.log('INSTANCE\tSTATE\tPORTS');
  console.log(rows);
}

function usage() {
  console.log(
    [
      'instance.js — run more than one Explore container of this repo at once.',
      '',
      `  ${SELF} <name>        create/start instance <name>, print its URL`,
      `  ${SELF} shell <name>  open a shell inside instance <name>`,
      `  ${SELF} stop <name>   stop + remove instance <name> (keeps its repo clone)`,
      `  ${SELF} list          list extra instances`,
      '',
      'Run on the host, from the explore/ folder. The normal single container',
      'is still just `npx @devcontainers/cli up`.',
    ].join('\n')
  );
}

const [cmd, arg] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  usage();
} else if (cmd === 'list') {
  list();
} else if (cmd === 'stop') {
  if (!validName(arg)) die(`Usage: ${SELF} stop <name>`);
  stop(arg);
} else if (cmd === 'shell') {
  if (!validName(arg)) die(`Usage: ${SELF} shell <name>`);
  shell(arg);
} else if (RESERVED.has(cmd)) {
  usage();
} else {
  // `instance.js <name>` shorthand for create/start.
  await create(cmd);
}
