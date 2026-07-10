/**
 * Model-fidelity resolution for auto-fallback (pure).
 *
 * Fallback continues the thread with the EXACT same underlying model id (and,
 * via the copied `ModelSelection.options`, the same reasoning effort). It may
 * only proceed if the target instance actually resolves that identical model —
 * never silently substituting a different one. Instances of the same driver
 * share the built-in model catalog, so the only variable is custom models,
 * which `mirrorPrimaryCustomModels` can inherit from the primary instance so
 * pools stay equivalent without duplicate maintenance.
 *
 * @module orchestration/autoFallback/modelFidelity
 */

/**
 * Resolve the effective `mirrorPrimaryCustomModels` flag. Absent defaults to
 * true for non-primary instances (they mirror the primary pool), false for the
 * primary instance itself (it owns the pool).
 */
export function resolveMirrorPrimaryCustomModels(input: {
  readonly flag: boolean | undefined;
  readonly isPrimary: boolean;
}): boolean {
  return input.flag ?? !input.isPrimary;
}

export interface TargetModelResolutionInput {
  readonly requiredModel: string;
  /** All model slugs the target instance advertises (built-in + its own custom). */
  readonly targetModelSlugs: readonly string[];
  /** The primary same-driver instance's custom model slugs. */
  readonly primaryCustomModelSlugs: readonly string[];
  /** Effective mirror flag for the target instance. */
  readonly mirrorPrimaryCustomModels: boolean;
}

/** The full set of model slugs the target instance can resolve, after mirroring. */
export function resolveTargetModelSlugs(input: TargetModelResolutionInput): ReadonlySet<string> {
  const slugs = new Set<string>(input.targetModelSlugs);
  if (input.mirrorPrimaryCustomModels) {
    for (const slug of input.primaryCustomModelSlugs) {
      slugs.add(slug);
    }
  }
  return slugs;
}

/**
 * Whether the target instance resolves the identical required model. This is
 * the fidelity gate: fallback proceeds only when this returns true.
 */
export function instanceResolvesModel(input: TargetModelResolutionInput): boolean {
  return resolveTargetModelSlugs(input).has(input.requiredModel);
}
