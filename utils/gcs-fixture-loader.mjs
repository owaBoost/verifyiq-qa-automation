/**
 * gcs-fixture-loader.mjs
 *
 * Loads QA fixture files for a given parseFileType.
 *
 * Fixture source strategy (in priority order):
 *   1. config/fixture-manifest.json  — curated, deterministic, no GCS auth needed
 *      Default when USE_LIVE_GCS_FIXTURES is not set.
 *   2. Live GCS listing              — gs://test-ai-docs-data-dev/qa-test-data/
 *      Used only when USE_LIVE_GCS_FIXTURES=true.
 *   3. Old qa-automation-dev registry (legacy fallback)
 *      Used only when --allow-registry-fallback is passed on the CLI.
 *
 * Usage:
 *   const fixtures = await loadFixturesFromGCS('Payslip');
 *   // => [{ file: "gs://…/Payslip/file.pdf", fileType: "Payslip",
 *   //       source: "fixture-manifest", folderName: "Payslip" }, …]
 *
 * Returns [] (does not throw) when:
 *   - parseFileType not found in manifest / no GCS folder match
 *   - the folder is empty
 *   - GCS is unreachable or credentials are missing (non-permission errors)
 * Callers are responsible for deciding whether to hard-fail or fall back.
 */

import { Storage } from '@google-cloud/storage';
import { readFileSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, '../config/fixture-manifest.json');

const GCS_BUCKET = process.env.QA_TEST_DATA_BUCKET || 'test-ai-docs-data-dev';
const GCS_BASE_PREFIX = process.env.QA_TEST_DATA_PREFIX || 'qa-test-data/';

/** File extensions considered valid fixture files */
const FIXTURE_EXTS = /\.(pdf|jpg|jpeg|png|gif|tiff|tif|webp)$/i;

// ── Folder-name → parseFileType map ──────────────────────────────────────────
// Keys are lowercased for case-insensitive matching against GCS folder names.
// Covers: exact camelCase names, human-readable labels, abbreviations, and
// common team shorthand that QA folders are likely to be named.

const FOLDER_MAP = {
  // Financial
  'bankstatement':                        'BankStatement',
  'bank statement':                       'BankStatement',
  'bank_statement':                       'BankStatement',
  'creditcardstatement':                  'CreditCardStatement',
  'credit card statement':                'CreditCardStatement',
  'credit card':                          'CreditCardStatement',
  'creditcard':                           'CreditCardStatement',
  'gcashtransactionhistory':              'GcashTransactionHistory',
  'gcash transaction history':            'GcashTransactionHistory',
  'gcash':                                'GcashTransactionHistory',
  'g-cash':                               'GcashTransactionHistory',

  // Employment
  'payslip':                              'Payslip',
  'pay slip':                             'Payslip',
  'payroll':                              'Payslip',
  'certificateofemployment':              'CertificateOfEmployment',
  'certificate of employment':            'CertificateOfEmployment',
  'coe':                                  'CertificateOfEmployment',

  // BIR / Tax
  'birform2316':                          'BIRForm2316',
  'bir form 2316':                        'BIRForm2316',
  'bir2316':                              'BIRForm2316',
  '2316':                                 'BIRForm2316',
  'birform2303':                          'BIRForm2303',
  'bir form 2303':                        'BIRForm2303',
  'bir2303':                              'BIRForm2303',
  '2303':                                 'BIRForm2303',
  'birform1701':                          'BIRForm1701',
  'bir form 1701':                        'BIRForm1701',
  'bir1701':                              'BIRForm1701',
  '1701':                                 'BIRForm1701',
  'birexemptioncertificate':              'BIRExemptionCertificate',
  'bir exemption certificate':            'BIRExemptionCertificate',
  'bir exemption':                        'BIRExemptionCertificate',

  // Government IDs
  'philippinenationalid':                 'PhilippineNationalID',
  'philippine national id':               'PhilippineNationalID',
  'national id':                          'PhilippineNationalID',
  'philsys':                              'PhilippineNationalID',
  'id':                                   'PhilippineNationalID', // generic "ID" → national ID
  'driverslicense':                       'DriversLicense',
  "driver's license":                     'DriversLicense',
  'drivers license':                      'DriversLicense',
  'driver license':                       'DriversLicense',
  'driving license':                      'DriversLicense',
  'dl':                                   'DriversLicense',
  'passport':                             'Passport',
  'sssid':                                'SSSID',
  'sss id':                               'SSSID',
  'sss card':                             'SSSID',
  'ssspersonalrecord':                    'SSSPersonalRecord',
  'sss personal record':                  'SSSPersonalRecord',
  'sss record':                           'SSSPersonalRecord',
  'sss e1':                               'SSSPersonalRecord',
  'e1':                                   'SSSPersonalRecord',
  'umid':                                 'UMID',
  'philhealthid':                         'PhilHealthID',
  'philhealth id':                        'PhilHealthID',
  'philhealth':                           'PhilHealthID',
  'phic':                                 'PhilHealthID',
  'tinid':                                'TINID',
  'tin id':                               'TINID',
  'tin':                                  'TINID',
  'votersid':                             'VotersID',
  "voter's id":                           'VotersID',
  'voters id':                            'VotersID',
  'voter id':                             'VotersID',
  'prcid':                                'PRCID',
  'prc id':                               'PRCID',
  'prc':                                  'PRCID',
  'postalid':                             'PostalID',
  'postal id':                            'PostalID',
  'postal':                               'PostalID',
  'hdmfid':                               'HDMFID',
  'hdmf id':                              'HDMFID',
  'pag-ibig id':                          'HDMFID',
  'pagibig id':                           'HDMFID',
  'pag ibig':                             'HDMFID',
  'hdmf':                                 'HDMFID',
  'nbiclearance':                         'NBIClearance',
  'nbi clearance':                        'NBIClearance',
  'nbi':                                  'NBIClearance',
  'acricard':                             'ACRICard',
  'acri card':                            'ACRICard',
  'acr i-card':                           'ACRICard',
  'acri':                                 'ACRICard',

  // Utility bills
  'electricutilitybillingstatement':      'ElectricUtilityBillingStatement',
  'electric utility billing statement':   'ElectricUtilityBillingStatement',
  'electricity bill':                     'ElectricUtilityBillingStatement',
  'electric bill':                        'ElectricUtilityBillingStatement',
  'electricitybill':                      'ElectricUtilityBillingStatement',
  'electricbill':                         'ElectricUtilityBillingStatement',
  'meralco':                              'ElectricUtilityBillingStatement',
  'waterutilitybillingstatement':         'WaterUtilityBillingStatement',
  'water utility billing statement':      'WaterUtilityBillingStatement',
  'water bill':                           'WaterUtilityBillingStatement',
  'waterbill':                            'WaterUtilityBillingStatement',
  'maynilad':                             'WaterUtilityBillingStatement',
  'manila water':                         'WaterUtilityBillingStatement',

  // Telco (generic)
  'telecobill':                           'TelcoBill',
  'telco bill':                           'TelcoBill',
  'telco':                                'TelcoBill',
  'telecom':                              'TelcoBill',
  // Telco brands
  'convergetelecohill':                   'ConvergeTelcoBill',
  'converge telco bill':                  'ConvergeTelcoBill',
  'converge':                             'ConvergeTelcoBill',
  'ditotelecohill':                       'DitoTelcoBill',
  'dito telco bill':                      'DitoTelcoBill',
  'dito':                                 'DitoTelcoBill',
  'globetelecohill':                      'GlobeTelcoBill',
  'globe telco bill':                     'GlobeTelcoBill',
  'globe':                                'GlobeTelcoBill',
  'pldttelecohill':                       'PLDTTelcoBill',
  'pldt telco bill':                      'PLDTTelcoBill',
  'pldt':                                 'PLDTTelcoBill',
  'skycabletelecohill':                   'SkyCableTelcoBill',
  'sky cable telco bill':                 'SkyCableTelcoBill',
  'sky cable':                            'SkyCableTelcoBill',
  'skycable':                             'SkyCableTelcoBill',
  'smarttelecohill':                      'SmartTelcoBill',
  'smart telco bill':                     'SmartTelcoBill',
  'smart':                                'SmartTelcoBill',

  // Corporate / business docs
  'seccertificateofincorporation':        'SECCertificateOfIncorporation',
  'sec certificate of incorporation':     'SECCertificateOfIncorporation',
  'sec cor':                              'SECCertificateOfIncorporation',
  'articlesofincoroporation':             'ArticlesOfIncorporation',
  'articles of incorporation':            'ArticlesOfIncorporation',
  'aoi':                                  'ArticlesOfIncorporation',
  'articlesofpartnership':                'ArticlesOfPartnership',
  'articles of partnership':              'ArticlesOfPartnership',
  'aop':                                  'ArticlesOfPartnership',
  'dtiregistrationcertificate':           'DTIRegistrationCertificate',
  'dti registration certificate':         'DTIRegistrationCertificate',
  'dti':                                  'DTIRegistrationCertificate',
  'dtipermit':                            'DTIPermit',
  'dti permit':                           'DTIPermit',
  'mayorspermit':                         'MayorsPermit',
  "mayor's permit":                       'MayorsPermit',
  'mayors permit':                        'MayorsPermit',
  'business permit':                      'MayorsPermit',
  'barangaycertificate':                  'BarangayCertificate',
  'barangay certificate':                 'BarangayCertificate',
  'barangay clearance':                   'BarangayCertificate',
  'boardresolution':                      'BoardResolution',
  'board resolution':                     'BoardResolution',
  'secretarycertificate':                 'SecretaryCertificate',
  'secretary certificate':                'SecretaryCertificate',
  'generalinformationsheet':              'GeneralInformationSheet',
  'general information sheet':            'GeneralInformationSheet',
  'gis':                                  'GeneralInformationSheet',
  'seccertificateofpartnership':          'SECCertificateOfPartnership',
  'sec certificate of partnership':       'SECCertificateOfPartnership',

  // Regulatory
  'amlcbspcertificateofregistration':                 'AMLCBSPCertificateOfRegistration',
  'amlcbsp certificate of registration':              'AMLCBSPCertificateOfRegistration',
  'amlcbspprovisionalcertificateofregistration':      'AMLCBSPProvisionalCertificateOfRegistration',
  'amlcbsp provisional certificate of registration':  'AMLCBSPProvisionalCertificateOfRegistration',
  'amlc provisional':                                 'AMLCBSPProvisionalCertificateOfRegistration',

  // Vehicles
  'orcr':                                 'ORCR',
  'or cr':                                'ORCR',
  'ltocertificateofregistration':         'LTOCertificateOfRegistration',
  'lto certificate of registration':      'LTOCertificateOfRegistration',
  'lto cr':                               'LTOCertificateOfRegistration',
  'ltoofficialreceipt':                   'LTOOfficialReceipt',
  'lto official receipt':                 'LTOOfficialReceipt',
  'lto or':                               'LTOOfficialReceipt',

  // Civil / personal
  'philippinebirthcertificate':           'PhilippineBirthCertificate',
  'philippine birth certificate':         'PhilippineBirthCertificate',
  'birth certificate':                    'PhilippineBirthCertificate',
  'psa':                                  'PhilippineBirthCertificate',

  // Subscriptions / digital receipts
  'hbomaxreceipt':                        'HBOMaxReceipt',
  'hbo max receipt':                      'HBOMaxReceipt',
  'hbo max':                              'HBOMaxReceipt',
  'netflixinvoice':                       'NetflixInvoice',
  'netflix invoice':                      'NetflixInvoice',
  'netflix':                              'NetflixInvoice',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the trailing folder segment from a GCS prefix string. */
function folderName(prefix) {
  return prefix.replace(/\/$/, '').split('/').pop() ?? '';
}

/**
 * Map a GCS folder name to a parseFileType.
 * Tries FOLDER_MAP first (case-insensitive), then an exact camelCase identity match.
 * Returns null if no mapping found.
 *
 * @param {string} name  e.g. "Payslip", "Electricity Bill", "COE"
 * @returns {string|null}
 */
export function mapFolderToFileType(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  if (FOLDER_MAP[lower]) return FOLDER_MAP[lower];
  // Identity fallback: folder name IS the parseFileType (e.g. "BankStatement" folder)
  const known = new Set(Object.values(FOLDER_MAP));
  if (known.has(name)) return name;
  return null;
}

// ── GCS operations ────────────────────────────────────────────────────────────

function makeStorage() {
  const keyFile = process.env.GOOGLE_SA_KEY_FILE;
  if (keyFile) {
    try {
      const sa = JSON.parse(readFileSync(keyFile, 'utf8'));
      console.log(`  [gcs-loader] auth        : GOOGLE_SA_KEY_FILE`);
      console.log(`  [gcs-loader] client_email: ${sa.client_email}`);
      console.log(`  [gcs-loader] project_id  : ${sa.project_id}`);
    } catch (e) {
      console.warn(`  [gcs-loader] WARNING: could not read SA key file (${keyFile}): ${e.message}`);
    }
  } else {
    console.log(`  [gcs-loader] auth        : Application Default Credentials (GOOGLE_SA_KEY_FILE not set)`);
  }
  console.log(`  [gcs-loader] bucket      : gs://${GCS_BUCKET}`);
  console.log(`  [gcs-loader] base prefix : ${GCS_BASE_PREFIX}`);

  return new Storage(keyFile ? { keyFilename: keyFile } : {});
}

/**
 * List all immediate sub-folders under GCS_BASE_PREFIX.
 * Uses delimiter='/' to simulate directory listing.
 *
 * @returns {Promise<Array<{ prefix: string, folderName: string, parseFileType: string|null }>>}
 */
export async function listQaFolders() {
  const storage = makeStorage();
  console.log(`  [gcs-loader] API call    : storage.bucket("${GCS_BUCKET}").getFiles({ prefix: "${GCS_BASE_PREFIX}", delimiter: "/" })`);
  const [, , apiResponse] = await storage.bucket(GCS_BUCKET).getFiles({
    prefix: GCS_BASE_PREFIX,
    delimiter: '/',
  });
  const prefixes = apiResponse.prefixes ?? [];
  console.log(`  [gcs-loader] raw prefixes: ${JSON.stringify(prefixes)}`);
  return prefixes.map(prefix => {
    const name = folderName(prefix);
    return { prefix, folderName: name, parseFileType: mapFolderToFileType(name) };
  });
}

/**
 * List fixture files under a GCS prefix, filtered by FIXTURE_EXTS.
 * Returns up to maxCount items — random sample when there are more.
 *
 * @param {string} prefix    GCS prefix, e.g. "qa-test-data/Payslip/"
 * @param {string} fileType  parseFileType to stamp onto results
 * @param {string} folder    Human-readable folder name (for reporting)
 * @param {number} maxCount
 */
async function listFilesInFolder(prefix, fileType, folder, maxCount) {
  const storage = makeStorage();
  const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix });
  const fixtures = files
    .filter(f => FIXTURE_EXTS.test(f.name) && !f.name.endsWith('/'))
    .map(f => ({
      file: `gs://${GCS_BUCKET}/${f.name}`,
      fileType,
      source: 'gcs',
      folderName: folder,
    }));

  // Sort for determinism, then cap
  const sorted = [...fixtures].sort((a, b) => a.file.localeCompare(b.file));
  if (sorted.length <= maxCount) return sorted;
  return sorted.slice(0, maxCount);
}

// ── Manifest-based fixture loading ───────────────────────────────────────────

/**
 * Load fixtures from config/fixture-manifest.json for a given parseFileType.
 *
 * Results are deterministic: sorted alphabetically by file path.
 * Returns all fixtures for the type by default; pass maxCount to cap the list.
 *
 * Reporter output: source=fixture-manifest
 *
 * @param {string} parseFileType  e.g. "Payslip"
 * @param {number} [maxCount]     cap returned fixtures (default: all)
 * @returns {Array<{ file, fileType, source: 'fixture-manifest', folderName }>}
 */
export function loadFixturesFromManifest(parseFileType, maxCount = Infinity) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    console.warn(`  [gcs-loader] Could not read fixture-manifest.json (${MANIFEST_PATH}): ${e.message}`);
    return [];
  }

  const group = manifest[parseFileType];
  if (!group || !Array.isArray(group.fixtures) || group.fixtures.length === 0) {
    console.log(`  [gcs-loader] parseFileType "${parseFileType}" not found in fixture-manifest.json`);
    console.log(`  [gcs-loader] Available types: ${Object.keys(manifest).filter(k => !k.startsWith('_')).join(', ')}`);
    return [];
  }

  // Sort for determinism — do not randomise manifest fixtures
  const sorted = [...group.fixtures].sort();
  const capped  = maxCount === Infinity ? sorted : sorted.slice(0, maxCount);

  console.log(`  [gcs-loader] ${capped.length}/${sorted.length} fixture(s) loaded from fixture-manifest (parseFileType=${parseFileType})`);
  return capped.map(file => ({
    file,
    fileType:   parseFileType,
    source:     'fixture-manifest',
    folderName: parseFileType,
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Thrown when GCS returns a 403 or equivalent permission error.
 *
 * Signals to callers that retrying will not help — the service account lacks
 * the required IAM permission and the issue must be fixed before re-running.
 * Callers should inspect err.retryable === false to suppress retry logic.
 */
export class GCSAccessDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GCSAccessDeniedError';
    this.retryable = false;
  }
}

/** Returns true for GCS 403 / permission-denied errors. */
function isAccessDenied(err) {
  if (err.code === 403) return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('access denied') || msg.includes('permission denied') || msg.includes('does not have storage');
}

/**
 * Load fixtures for a given parseFileType.
 *
 * Routing:
 *   - Default (USE_LIVE_GCS_FIXTURES not set): reads config/fixture-manifest.json
 *     Results are deterministic (sorted). All manifest fixtures returned unless
 *     maxCount is explicitly provided.
 *   - USE_LIVE_GCS_FIXTURES=true: lists gs://GCS_BUCKET/GCS_BASE_PREFIX live.
 *     Results are sorted (deterministic). maxCount defaults to 3 for live GCS.
 *
 * Returns [] (does not throw) when:
 *   - parseFileType not found in manifest
 *   - GCS is unreachable or credentials are missing (non-permission errors)
 *   - No folder maps to parseFileType on live GCS
 *   - The matching folder is empty
 *
 * Throws GCSAccessDeniedError when:
 *   - GCS returns HTTP 403 on any call (live GCS path only)
 *   Callers must not retry on GCSAccessDeniedError — fix IAM first.
 *
 * @param {string} parseFileType  e.g. "Payslip"
 * @param {number|null} maxCount  cap returned fixtures (null = use path defaults)
 * @returns {Promise<Array<{ file, fileType, source, folderName }>>}
 */
export async function loadFixturesFromGCS(parseFileType, maxCount = null) {
  if (process.env.USE_LIVE_GCS_FIXTURES !== 'true') {
    // Manifest path — deterministic, no GCS auth required
    return loadFixturesFromManifest(parseFileType, maxCount ?? Infinity);
  }

  // ── Live GCS path ─────────────────────────────────────────────────────────
  const liveMax = maxCount ?? 3;

  let folders;
  try {
    folders = await listQaFolders();
  } catch (err) {
    if (isAccessDenied(err)) {
      throw new GCSAccessDeniedError(
        `Access denied listing gs://${GCS_BUCKET}/${GCS_BASE_PREFIX}: ${err.message}`,
      );
    }
    console.warn(`  [gcs-loader] Could not list folders in gs://${GCS_BUCKET}/${GCS_BASE_PREFIX}: ${err.message}`);
    return [];
  }

  const match = folders.find(f => f.parseFileType === parseFileType);
  if (!match) {
    console.log(`  [gcs-loader] No folder found for parseFileType "${parseFileType}" in gs://${GCS_BUCKET}/${GCS_BASE_PREFIX}`);
    console.log(`  [gcs-loader] Available folders: ${folders.map(f => `${f.folderName}(→${f.parseFileType ?? 'unmapped'})`).join(', ')}`);
    return [];
  }

  console.log(`  [gcs-loader] Matched folder: ${match.prefix} → ${parseFileType}`);

  let fixtures;
  try {
    fixtures = await listFilesInFolder(match.prefix, parseFileType, match.folderName, liveMax);
  } catch (err) {
    if (isAccessDenied(err)) {
      throw new GCSAccessDeniedError(
        `Access denied listing files in gs://${GCS_BUCKET}/${match.prefix}: ${err.message}`,
      );
    }
    console.warn(`  [gcs-loader] Could not list files in ${match.prefix}: ${err.message}`);
    return [];
  }

  console.log(`  [gcs-loader] ${fixtures.length} fixture(s) loaded from live GCS`);
  return fixtures;
}

// ── CLI test entry point ───────────────────────────────────────────────────────
// Usage: node utils/gcs-fixture-loader.mjs [parseFileType]
// Example: node utils/gcs-fixture-loader.mjs Payslip

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  import('dotenv/config').then(async () => {
    const parseFileType = process.argv[2] || 'Payslip';
    const useLive = process.env.USE_LIVE_GCS_FIXTURES === 'true';
    console.log(`\n=== gcs-fixture-loader CLI test ===`);
    console.log(`Requested parseFileType : ${parseFileType}`);
    console.log(`Source                  : ${useLive ? `live GCS (gs://${GCS_BUCKET}/${GCS_BASE_PREFIX})` : 'fixture-manifest.json'}`);
    console.log(`USE_LIVE_GCS_FIXTURES   : ${useLive}\n`);

    try {
      const fixtures = await loadFixturesFromGCS(parseFileType);
      if (fixtures.length === 0) {
        console.log(`\n[RESULT] No fixtures returned.`);
        if (useLive) {
          console.log(`  → Check that the folder "${parseFileType}" exists under gs://${GCS_BUCKET}/${GCS_BASE_PREFIX}`);
          console.log(`  → Check that GOOGLE_SA_KEY_FILE SA has storage.objects.list on the bucket`);
        } else {
          console.log(`  → Check that "${parseFileType}" is listed in config/fixture-manifest.json`);
          console.log(`  → Set USE_LIVE_GCS_FIXTURES=true to fall through to live GCS listing`);
        }
      } else {
        console.log(`\n[RESULT] ${fixtures.length} fixture(s) found:`);
        for (const f of fixtures) {
          console.log(`  ${f.file}  (fileType=${f.fileType}, source=${f.source})`);
        }
      }
    } catch (err) {
      if (err.name === 'GCSAccessDeniedError') {
        console.error(`\n[RESULT] ACCESS DENIED (non-retryable): ${err.message}`);
        console.error(`  → Fix IAM: grant the SA "storage.objects.list" on gs://${GCS_BUCKET}`);
      } else {
        console.error(`\n[RESULT] ERROR: ${err.message}`);
      }
      process.exit(1);
    }
  });
}
