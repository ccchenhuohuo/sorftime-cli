/**
 * Single source of truth for the CLI version.
 *
 * `test/version.test.ts` asserts this matches package.json, because the value
 * previously sat in four places and any of them could drift unnoticed.
 */
export const VERSION = "2.0.0";
export const USER_AGENT = `sorftime-cli/${VERSION}`;
