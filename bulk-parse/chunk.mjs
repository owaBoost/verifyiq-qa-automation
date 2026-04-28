/**
 * chunk.mjs — Split an array into chunks of a given size.
 *
 * The /v1/documents/batch endpoint accepts max 4 items per call.
 */

/**
 * @param {Array} items
 * @param {number} size  Max items per chunk (default 4)
 * @returns {Array<Array>}
 */
export function chunk(items, size = 4) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
