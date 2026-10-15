/**
 * Property tests for the tree helpers the engine uses to compute transition domains and to decide
 * whether two regions' transitions conflict.
 *
 * Each helper is checked against an independent brute-force implementation over generated
 * statechart trees, so the fast path is compared with a specification rather than with examples
 * someone thought of. The trees carry the kinds a machine can declare, including parallel states,
 * because a parallel state is exactly the node a domain walk has to skip.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { intersects, isDescendantOf, leastCommonCompoundAncestor } from "../src/graph.js";

/** State kinds a machine can declare. Only a compound state can be a transition domain. */
type Kind = "atomic" | "compound" | "parallel";

/** A generated node before it is linked into a tree. */
type NodeSpec = { kind: Kind; children: NodeSpec[] };

/** A linked node: the shape the helpers see, plus a path for readable counterexamples. */
type TestNode = {
  kind: Kind;
  path: string;
  parent: TestNode;
  children: TestNode[];
};

/** Runs per property: enough to cover the generated shapes without slowing the suite down. */
const NUM_RUNS = 250;

/**
 * Legal statechart shapes: a parallel state has at least two regions, a compound state at least one
 * child, and an atomic state none. Depth and breadth are bounded so counterexamples stay readable.
 */
const nodeSpec = (depth: number): fc.Arbitrary<NodeSpec> => {
  if (depth === 0) {
    return fc.constant<NodeSpec>({ kind: "atomic", children: [] });
  }

  const leaf = fc.constant<NodeSpec>({ kind: "atomic", children: [] });
  const compound = fc.record<NodeSpec>({
    kind: fc.constant("compound"),
    children: fc.array(nodeSpec(depth - 1), { minLength: 1, maxLength: 3 }),
  });
  const parallel = fc.record<NodeSpec>({
    kind: fc.constant("parallel"),
    children: fc.array(nodeSpec(depth - 1), { minLength: 2, maxLength: 3 }),
  });

  return fc.oneof(leaf, compound, parallel);
};

/** A generated tree: a virtual root with at least one declared top-level state. */
const treeSpec = fc.record<NodeSpec>({
  kind: fc.constant("compound"),
  children: fc.array(nodeSpec(3), { minLength: 1, maxLength: 3 }),
});

/**
 * Positions in a generated tree, resolved to nodes once the tree exists.
 *
 * Generating positions rather than nodes keeps each property a single fast-check run: the size of
 * the tree is only known after it has been built.
 */
const positions = (maxLength: number): fc.Arbitrary<number[]> =>
  fc.array(fc.double({ min: 0, max: 0.999999, noNaN: true }), { minLength: 1, maxLength });

/** Links a spec into a tree whose root is its own parent, mirroring a compiled machine. */
const materialise = (spec: NodeSpec): { root: TestNode; nodes: TestNode[] } => {
  const root = {
    kind: "compound" as Kind,
    path: "",
    parent: undefined as unknown as TestNode,
    children: [],
  };
  root.parent = root;
  const nodes: TestNode[] = [];

  const link = (parent: TestNode, childSpec: NodeSpec, path: string): void => {
    const node: TestNode = { kind: childSpec.kind, path, parent, children: [] };
    parent.children.push(node);
    nodes.push(node);
    childSpec.children.forEach((grandChild, index) => {
      link(node, grandChild, `${path}.${index}`);
    });
  };

  spec.children.forEach((child, index) => {
    link(root, child, `n${index}`);
  });

  return { root, nodes };
};

/** The nodes at the given positions, which may repeat the same node. */
const nodesAt = (nodes: TestNode[], at: number[]): TestNode[] =>
  at.map((position) => nodes[Math.floor(position * nodes.length)]!);

/** Every ancestor of `node`, deepest first, ending with the self-parenting root. */
const ancestorsOf = (node: TestNode): TestNode[] => {
  const chain: TestNode[] = [];
  let current = node.parent;
  while (true) {
    chain.push(current);
    if (current.parent === current) {
      return chain;
    }
    current = current.parent;
  }
};

/** True when `node` sits strictly below `ancestor`, by walking every parent link. */
const isStrictDescendant = (node: TestNode, ancestor: TestNode): boolean =>
  ancestorsOf(node).includes(ancestor);

/**
 * The specification of a transition domain: the deepest compound node that is strictly above every
 * node in the set, or the root when no compound node qualifies. Only compound nodes are domains, so
 * a parallel state that contains the whole set is passed over.
 */
const domainBySpecification = (nodes: TestNode[], root: TestNode): TestNode => {
  const [first] = nodes;
  if (first === undefined) {
    return root;
  }
  for (const candidate of ancestorsOf(first)) {
    if (candidate.kind === "compound" && nodes.every((node) => isStrictDescendant(node, candidate))) {
      return candidate;
    }
  }
  return root;
};

/** The brute-force intersection: a shared member, found by scanning instead of by size. */
const intersectsBySpecification = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean => {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
};

/** Renders a set of nodes as a path list, so a failing counterexample names states. */
const describeAll = (nodes: Iterable<TestNode>): string =>
  [...nodes].map((node) => node.path).join(", ") || "(none)";

describe("isDescendantOf", () => {
  it("agrees with walking the parent chain for picked pairs of nodes", () => {
    fc.assert(
      fc.property(treeSpec, positions(4), (spec, at) => {
        const { nodes } = materialise(spec);
        const [first, ...rest] = nodesAt(nodes, at);
        if (first === undefined) {
          return;
        }

        for (const other of [first, ...rest]) {
          expect(isDescendantOf(first, other), `${first.path} below ${other.path}`).toBe(
            isStrictDescendant(first, other),
          );
          expect(isDescendantOf(other, first), `${other.path} below ${first.path}`).toBe(
            isStrictDescendant(other, first),
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is never true for a node and itself", () => {
    fc.assert(
      fc.property(treeSpec, positions(3), (spec, at) => {
        const { nodes } = materialise(spec);
        for (const node of nodesAt(nodes, at)) {
          expect(isDescendantOf(node, node), node.path).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("holds for the virtual root and never for an unrelated subtree", () => {
    fc.assert(
      fc.property(treeSpec, positions(3), (spec, at) => {
        const { root, nodes } = materialise(spec);
        for (const node of nodesAt(nodes, at)) {
          expect(isDescendantOf(node, root), node.path).toBe(true);
          expect(isDescendantOf(root, node), node.path).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("intersects", () => {
  it("agrees with a brute-force scan over generated configurations", () => {
    fc.assert(
      fc.property(treeSpec, positions(4), positions(4), (spec, leftAt, rightAt) => {
        const { nodes } = materialise(spec);
        const left = new Set(nodesAt(nodes, leftAt));
        const right = new Set(nodesAt(nodes, rightAt));

        expect(
          intersects(left, right),
          `${describeAll(left)} against ${describeAll(right)}`,
        ).toBe(intersectsBySpecification(left, right));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is symmetric, including when the sets differ in size", () => {
    fc.assert(
      fc.property(treeSpec, positions(5), positions(2), (spec, leftAt, rightAt) => {
        const { nodes } = materialise(spec);
        const left = new Set(nodesAt(nodes, leftAt));
        const right = new Set(nodesAt(nodes, rightAt));

        expect(intersects(left, right), describeAll(left)).toBe(intersects(right, left));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("reports no intersection when either set is empty", () => {
    fc.assert(
      fc.property(treeSpec, positions(3), (spec, at) => {
        const { nodes } = materialise(spec);
        const empty = new Set<TestNode>();
        const nonEmpty = new Set(nodesAt(nodes, at));

        expect(intersects(empty, nonEmpty)).toBe(false);
        expect(intersects(nonEmpty, empty)).toBe(false);
        expect(intersects(empty, empty)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("leastCommonCompoundAncestor", () => {
  it("agrees with the deepest common compound ancestor of the set", () => {
    fc.assert(
      fc.property(treeSpec, positions(4), (spec, at) => {
        const { root, nodes } = materialise(spec);
        const selection = nodesAt(nodes, at);

        expect(
          leastCommonCompoundAncestor(selection, root).path,
          describeAll(selection),
        ).toBe(domainBySpecification(selection, root).path);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("never returns a node below the set it describes, and never a non-compound node", () => {
    fc.assert(
      fc.property(treeSpec, positions(4), (spec, at) => {
        const { root, nodes } = materialise(spec);
        const selection = nodesAt(nodes, at);
        const domain = leastCommonCompoundAncestor(selection, root);

        expect(domain.kind === "compound" || domain === root, describeAll(selection)).toBe(true);
        expect(selection.every((node) => isStrictDescendant(node, domain)), describeAll(selection)).toBe(
          true,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("resolves an empty set to the root", () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const { root } = materialise(spec);
        expect(leastCommonCompoundAncestor([], root)).toBe(root);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("agrees with the naive walk when the set is every declared state", () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const { root, nodes } = materialise(spec);
        expect(leastCommonCompoundAncestor(nodes, root)).toBe(domainBySpecification(nodes, root));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
