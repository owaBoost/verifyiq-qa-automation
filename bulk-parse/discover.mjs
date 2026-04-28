/**
 * discover.mjs — Discover .pdf fixtures from a GCS prefix.
 *
 * Usage:
 *   import { discoverFixtures } from './discover.mjs';
 *   const files = await discoverFixtures('gs://bucket/prefix/', 'BankStatement');
 *   // => [{ file: 'gs://bucket/prefix/foo.pdf', fileType: 'BankStatement' }, ...]
 */

import { Storage } from '@google-cloud/storage';

/**
 * List all .pdf files under a GCS prefix.
 *
 * @param {string} gcsPrefix   e.g. "gs://bucket/path/to/folder/"
 * @param {string} fileType    Document type to assign to each fixture
 * @returns {Promise<Array<{file: string, fileType: string}>>}
 */
export async function discoverFixtures(gcsPrefix, fileType) {
  const match = gcsPrefix.match(/^gs:\/\/([^/]+)\/(.*)$/);
  if (!match) throw new Error(`Invalid GCS prefix: ${gcsPrefix}`);

  const [, bucket, prefix] = match;
  const storage = new Storage({ keyFilename: process.env.GOOGLE_SA_KEY_FILE });

  const [files] = await storage.bucket(bucket).getFiles({ prefix });

  const pdfs = files
    .filter(f => /\.pdf$/i.test(f.name))
    .map(f => ({ file: `gs://${bucket}/${f.name}`, fileType }));

  console.log(`  Discovered ${pdfs.length} PDF files under gs://${bucket}/${prefix}`);
  return pdfs;
}
