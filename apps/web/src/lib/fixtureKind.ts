/**
 * Fixture-kind helpers now live in @wac/shared so the generator's resolver and
 * the API's fixtures picker derive the same mount/type from the products
 * catalog. Re-exported here so existing web imports keep working.
 */
export {
  deriveFixtureKind,
  MOUNT_LABELS,
  POSE_DEFAULTS,
  COVERAGE_DEFAULTS,
  type FixtureKind,
  type PosePreset,
} from "@wac/shared";
