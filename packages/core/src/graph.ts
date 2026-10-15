/**
 * Tree helpers the engine uses to compute transition domains and to decide whether two regions'
 * transitions conflict.
 *
 * Every helper works on the shape a compiled state tree has: a node knows its parent and its own
 * kind, and the virtual root is its own parent, which is what lets a walk terminate without
 * carrying a separate root reference. Only a compound state can be a transition domain, so a
 * parallel state is skipped and the walk continues above it.
 *
 * The functions are pure, and `tests/graph.test.ts` checks each of them against a brute-force
 * implementation over generated trees, because together they decide which states leave and enter
 * and when two regions' transitions cancel each other out.
 */

/**
 * A node of a state tree, as far as the tree helpers need to see it.
 *
 * `TNode` is the concrete node type, so a helper returns exactly what it was given. The virtual
 * root satisfies the shape by being its own parent.
 *
 * @typeParam TNode - Concrete node type, which links back to itself through `parent`.
 */
export type TreeNode<TNode> = {
  /** The node's parent. The virtual root of a tree is its own parent. */
  readonly parent: TNode;
  /** What the node is. Only `"compound"` can be a transition domain. */
  readonly kind: string;
};

/**
 * True when `node` sits strictly below `ancestor`, so a node is never a descendant of itself.
 *
 * The walk climbs the parent chain until it meets `ancestor`, and stops at the self-parenting root
 * when the ancestor is above it. Callers pass declared states, so the root is the only node that
 * parents itself.
 *
 * @param node - Node to test.
 * @param ancestor - Node that must be a proper ancestor of `node`.
 * @returns `true` when `ancestor` is found on the way up from `node`.
 */
export const isDescendantOf = <TNode extends TreeNode<TNode>>(
  node: TNode,
  ancestor: TNode,
): boolean => {
  let current = node.parent;
  while (current !== ancestor && current.parent !== current) {
    current = current.parent;
  }
  return current === ancestor;
};

/**
 * The least common compound ancestor of `nodes`: the nearest ancestor of all of them that is
 * compound, or the virtual root.
 *
 * Parallel states are skipped, which is SCXML's definition of the transition domain. It is why a
 * transition declared on a region of a parallel state, including a self-transition, exits and
 * re-enters the whole parallel subtree: the domain has to be a compound state above the parallel
 * state, so the parallel state is one of the proper descendants it exits.
 *
 * The walk starts at the parent of `nodes[0]`, because a domain has to be strictly above the
 * states it contains. An empty set resolves to `root`, and the root is its own parent, so the walk
 * needs no special case for reaching it.
 *
 * Every node has to be a declared state of the same tree; the virtual root is passed as `root`, not
 * as a member of `nodes`.
 *
 * @param nodes - States whose shared domain is wanted.
 * @param root - The virtual root of the tree they belong to.
 * @returns The deepest compound ancestor of every node, or `root` when there is none.
 */
export const leastCommonCompoundAncestor = <TNode extends TreeNode<TNode>>(
  nodes: readonly TNode[],
  root: TNode,
): TNode => {
  const first = nodes[0] ?? root;
  let ancestor = first.parent;
  while (
    ancestor.kind !== "compound" || !nodes.every((node) => isDescendantOf(node, ancestor))
  ) {
    ancestor = ancestor.parent;
  }
  return ancestor;
};

/**
 * True when two sets share at least one member.
 *
 * The smaller set is iterated, so the number of lookups is the smaller of the two sizes.
 *
 * @param left - First set.
 * @param right - Second set.
 * @returns `true` when one member appears in both sets.
 */
export const intersects = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean => {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) {
      return true;
    }
  }
  return false;
};
