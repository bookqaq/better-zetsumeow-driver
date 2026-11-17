/**
 * Overlap between the two Zetsu63 layout modes.
 *
 * Feeds the layout-mismatch consent dialogs (config restore and extension
 * imports): when an operation's source layout differs from the device layout,
 * the dialog shows how many keys can be written and how many will be skipped.
 */

import { KEY_LAYOUTS } from '../generated/product-zetsu63.ts';

export interface LayoutOverlapInfo {
  readonly sourceLayout: 'compact65' | 'extended79';
  readonly targetLayout: 'compact65' | 'extended79';
  /** Keys present in both layouts. */
  readonly sharedKeys: number;
  /** Source-layout keys the target layout does not know. */
  readonly skippedKeys: number;
}

/**
 * Overlap between two keyboard layouts, compared by `hardCode` membership:
 * how many source-layout keys also exist on the target layout, and how many
 * source-layout keys the target layout does not know.
 */
export function layoutOverlapInfo(
  sourceLayout: 'compact65' | 'extended79',
  targetLayout: 'compact65' | 'extended79',
): LayoutOverlapInfo {
  const targetCodes = new Set(KEY_LAYOUTS[targetLayout].keys.map((key) => key.hardCode));
  const sourceKeys = KEY_LAYOUTS[sourceLayout].keys;
  const sharedKeys = sourceKeys.filter((key) => targetCodes.has(key.hardCode)).length;
  return {
    sourceLayout,
    targetLayout,
    sharedKeys,
    skippedKeys: sourceKeys.length - sharedKeys,
  };
}
