import { component, CompositionError, type Component } from './runtime.mts';

interface Option {
  readonly key: string;
  readonly description: string;
}

export interface Candidate<I, O> extends Option {
  readonly component: Component<I, O>;
}

function uniqueKeys(options: readonly Option[]): void {
  const keys = new Set<string>();
  for (const option of options) {
    if (keys.has(option.key)) throw new CompositionError('invalid_selection');
    keys.add(option.key);
  }
}

// Code determines availability and dispatches; the selector only supplies a key.
export function route<I, O>(
  name: string,
  select: Component<{ input: I; candidates: readonly Option[] }, string | null>,
  candidates: (input: I) => readonly Candidate<I, O>[],
): Component<I, O> {
  return component<I, O>(name, async (input, scope) => {
    const available = candidates(input);
    if (available.length === 0) throw new CompositionError('no_match');
    uniqueKeys(available);
    const choice = await scope.call(select, {
      input,
      candidates: available.map(({ key, description }) => ({ key, description })),
    });
    if (choice === null) throw new CompositionError('no_match');
    const selected = available.find(candidate => candidate.key === choice);
    if (!selected) throw new CompositionError('invalid_selection');
    return scope.call(selected.component, input);
  });
}

// Independent native questions over one state belong in one request inside a member.
// Combining component results is explicit application policy, not probability math.
export function ensemble<I, O>(
  name: string,
  members: readonly Component<I, O>[],
  combine: Component<{ input: I; results: readonly O[] }, O>,
): Component<I, O> {
  return component<I, O>(name, async (input, scope) => {
    if (members.length === 0) throw new CompositionError('invalid_options');
    const results = await scope.all(members.map(member => ({ component: member, input })));
    return scope.call(combine, { input, results });
  });
}

export interface Node extends Option {
  readonly children?: readonly Node[];
}

interface HierarchyInput {
  document: string;
  path?: readonly string[];
}

interface HierarchyResult {
  path: string[];
  label: string;
}

// The retained tree is the source of truth; only branching requires a judgment.
export function hierarchy(
  name: string,
  tree: Node,
  judge: Component<{
    document: string;
    path: readonly string[];
    candidates: readonly Option[];
  }, string | null>,
): Component<HierarchyInput, HierarchyResult> {
  const classify: Component<HierarchyInput, HierarchyResult> = component(name, async ({ document, path = [] }, scope) => {
    let node = tree;
    for (const key of path) {
      const siblings = node.children ?? [];
      uniqueKeys(siblings);
      const child = siblings.find(candidate => candidate.key === key);
      if (!child) throw new CompositionError('invalid_selection');
      node = child;
    }

    const children = node.children ?? [];
    uniqueKeys(children);
    if (children.length === 0) return { path: [...path], label: node.description };

    const choice = children.length === 1
      ? children[0]!.key
      : await scope.call(judge, {
        document,
        path,
        candidates: children.map(({ key, description }) => ({ key, description })),
      });
    if (choice === null) throw new CompositionError('no_match');
    if (!children.some(child => child.key === choice)) throw new CompositionError('invalid_selection');
    return scope.call(classify, { document, path: [...path, choice] });
  });
  return classify;
}
