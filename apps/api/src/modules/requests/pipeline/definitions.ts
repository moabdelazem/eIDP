import type { DeployTarget } from '@eidp/contracts/requests'

/**
 * The old portal's `utils/tech_config.py`, as data: each build technology,
 * the application in inventories it is copied from (per deploy target), and
 * what is changed in the copy. The old generator did not hold templates of
 * its own — it took a real application of the same kind and patched it — so
 * this says which one, and the patches.
 *
 * Kept as the old file had it, key for key, so the two can be compared; what
 * reads it is `technologies.ts` and the generator.
 *
 * What the old form (`pipeline_request_ui.py`) added on top, for whoever
 * registers these:
 * - `artifact_id` and `nuget_name` default to the application name;
 * - Maven's `group_path` is never asked for — it is always `group_id`;
 * - only DBScripts skipped the namespaces (writing
 *   `host_vars/localhost/vars.yml` with `ansible_connection: local` instead);
 *   Database_Microsoft asked for them though it deploys from the host too.
 *   That was a bug: here every database skips them (`noNamespacesOf`).
 *
 * The references are where the templates are *extracted from*, once, not
 * what is read at approval. The old generator copied the live application
 * each time, so an edit, rename or deletion of South_Cairo_Token_Job changed
 * or broke every pipeline after it, and its own hostnames, ports and database
 * names came along. The templates live in e-IDP, versioned and reviewed; a
 * reference that has moved on is reported as drift, not followed.
 */

/** An application in inventories: `<project>/group_vars/<app>`. */
export type InventoryApp = { project: string; app: string }

/** A key set in one of the copied files: `top.sub = format(version)`; without a format, the version itself. */
export type TagOverride = { file: string; top: string; sub: string; format?: string }

export type TechnologyDefinition = {
  label: string
  /** The repository the application's own code-side files come from (ADO project/repo), when there is one. */
  referenceTemplate: string | null
  k8sReferenceTemplate: string | null
  /** The inventories application copied for OCP, and for K8s (null: the technology does not deploy to K8s). */
  inventoryReference: InventoryApp
  k8sInventoryReference: InventoryApp | null
  versions: string[]
  requiredFields: string[]
  /** A field that is a choice, and its choices. */
  fieldOptions?: Record<string, string[]>
  /** Keys set from the version, in the copied files. */
  versionTagOverrides?: TagOverride[]
  /** Values that depend on the version: version → field → value. */
  versionFieldOverrides?: Record<string, Record<string, string>>
  /** Flutter: the reference app depends on the app_path chosen. */
  appPathReferenceMap?: Record<string, InventoryApp>
  dockerfileByTarget?: Partial<Record<DeployTarget, string>>
  /** Files written as they are, by name. */
  generatedFiles?: Record<string, string>
  /** A database: no namespaces, deployed from the host. */
  isDatabase?: boolean
}

const OCP_RESOURCES_YML = `replicas: 1
resources:
  requests:
    memory: 256Mi
    cpu: .25
  limits:
    memory: 1024Mi
    cpu: 1
`

export const TECHNOLOGIES: Record<string, TechnologyDefinition> = {
  Maven_InContainer: {
    label: 'Java (Maven In-Container)',
    referenceTemplate: 'CashCollection_Billers/Central_Labs_Service',
    inventoryReference: { project: 'Electricity_Billers', app: 'South_Cairo_Token_Job' },
    k8sReferenceTemplate: 'MobilityHub/MobilityHub_Admin',
    k8sInventoryReference: { project: 'MobilityHub', app: 'MobilityHub_Admin' },
    versions: ['21', '17', '11', '8'],
    requiredFields: ['artifact_id', 'group_id'],
    versionTagOverrides: [
      { file: 'Spring.yml', top: 'build_image', sub: 'tag', format: '3-eclipse-temurin-{version}' },
      { file: 'Spring.yml', top: 'deploy_image', sub: 'tag', format: '{version}-alpine' },
    ],
  },
  DotNetCore: {
    label: '.NET Core',
    referenceTemplate: 'LPGMS_Penalty/LPGMS.PWebApi',
    inventoryReference: { project: 'LPGMS_Penalty', app: 'LPGMS.PWebApi' },
    k8sReferenceTemplate: null,
    k8sInventoryReference: null,
    versions: ['10.0', '8.0', '6.0'],
    requiredFields: ['nuget_name'],
    versionFieldOverrides: {
      '10.0': { dockerfile_name: 'Dockerfile-User-global', packages: 'tz-global' },
      '8.0': { dockerfile_name: 'Dockerfile-User', packages: 'tz' },
      '6.0': { dockerfile_name: 'Dockerfile-User', packages: 'tz' },
    },
    versionTagOverrides: [
      { file: 'cicd.yml', top: 'build_image', sub: 'tag' },
      { file: 'cicd.yml', top: 'deploy_image', sub: 'tag' },
    ],
  },
  Flutter: {
    label: 'Flutter',
    referenceTemplate: 'MOE_Platform/MOE_Portal',
    inventoryReference: { project: 'MOE_Platform', app: 'MOE_Android' },
    appPathReferenceMap: {
      android: { project: 'MOE_Platform', app: 'MOE_Android' },
      web: { project: 'GAFI_DIGITAL', app: 'GAFI_DN_Ef_Portal' },
    },
    k8sReferenceTemplate: 'MobilityHub/Mobility_FE_portal',
    k8sInventoryReference: { project: 'MobilityHub', app: 'Mobility_FE_portal' },
    versions: ['3.29.3', '3.32.0', '3.35.5'],
    requiredFields: ['app_path'],
    fieldOptions: { app_path: ['android', 'web'] },
    versionTagOverrides: [{ file: 'Flutter.yml', top: 'build_image', sub: 'tag' }],
  },
  Tag_Nginx_RP: {
    label: 'Reverse Proxy (Nginx)',
    referenceTemplate: 'GAFI_Digital_Network/GAFI_DN_Ef_Portal_RP',
    inventoryReference: { project: 'GAFI_Digital_Network', app: 'GAFI_DN_Ef_Portal_RP' },
    k8sReferenceTemplate: 'MobilityHub/Mobility_RP',
    k8sInventoryReference: { project: 'MobilityHub', app: 'Mobility_RP' },
    versions: ['alpine-slim'],
    requiredFields: [],
    dockerfileByTarget: { OCP: 'Dockerfile_RP', K8s: 'Dockerfile_RP_k8s' },
    versionTagOverrides: [{ file: 'Nginx.yml', top: 'deploy_image', sub: 'tag' }],
  },
  NPM_InContainer: {
    label: 'NPM (Angular / Node)',
    referenceTemplate: 'UNIFIED_TAX_NUMBER/UNIFIED_TAX_NUMBER_FE',
    inventoryReference: { project: 'UNIFIED_TAX_NUMBER', app: 'UNIFIED_TAX_NUMBER_FE' },
    k8sReferenceTemplate: null,
    k8sInventoryReference: null,
    versions: ['22', '20', '18'],
    requiredFields: [],
    generatedFiles: { 'ocp_resources.yml': OCP_RESOURCES_YML },
    versionTagOverrides: [
      { file: 'NPM.yml', top: 'archive_image', sub: 'tag' },
      { file: 'NPM.yml', top: 'build_image', sub: 'tag' },
    ],
  },
  PHP_Laravel: {
    label: 'PHP (Laravel)',
    referenceTemplate: 'Schools_Portals/Schools_Portals',
    inventoryReference: { project: 'Schools_Portals', app: 'Schools_Portals' },
    k8sReferenceTemplate: null,
    k8sInventoryReference: null,
    versions: ['8.2-apache'],
    requiredFields: [],
    versionTagOverrides: [{ file: 'cicd.yml', top: 'deploy_image', sub: 'tag' }],
  },
  Database_Microsoft: {
    label: 'Database (Microsoft SQL Server)',
    referenceTemplate: null,
    inventoryReference: { project: 'MOSS_SERVER', app: 'MOSS_KaramaMeezaAuth_DB' },
    k8sReferenceTemplate: null,
    k8sInventoryReference: null,
    versions: [],
    requiredFields: [],
    isDatabase: true,
  },
  DBScripts: {
    label: 'DB (PostgreSQL)',
    referenceTemplate: null,
    inventoryReference: { project: 'UNIFIED_TAX_NUMBER', app: 'UNIFIED_TAX_NUMBER_DB' },
    k8sReferenceTemplate: null,
    k8sInventoryReference: null,
    versions: [],
    requiredFields: [],
    isDatabase: true,
  },
}

/**
 * Not in the old portal, which took these as typed: a mistyped group id or
 * package name only showed up when the first build failed. What each must
 * look like, checked on the form and at filing.
 */
export const FIELD_RULES: Record<string, { label: string; pattern: string; help: string; default?: '{application}' }> = {
  artifact_id: { label: 'Artifact ID', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$', help: 'Letters, digits, dots, dashes and underscores, as in the pom.', default: '{application}' },
  group_id: { label: 'Group ID', pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$', help: 'A Java package name, like eg.com.efinance.billing.' },
  nuget_name: { label: 'NuGet package', pattern: '^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$', help: 'Letters, digits, dots, dashes and underscores.', default: '{application}' },
}

/** A database deploys from the host: no namespaces, for either kind. */
export const noNamespacesOf = (d: TechnologyDefinition): boolean => Boolean(d.isDatabase)

/** The deploy targets a technology has a reference for. */
export const targetsOf = (d: TechnologyDefinition): DeployTarget[] => (d.k8sInventoryReference ? ['OCP', 'K8s'] : ['OCP'])

/** The environments a new project's namespaces are asked for, with the cluster each is in. */
export const NAMESPACE_ENVIRONMENTS: Record<DeployTarget, { key: string; label: string; cluster: 'HQ' | 'DR' }[]> = {
  OCP: [
    { key: 'dev', label: 'DEV', cluster: 'HQ' },
    { key: 'qc', label: 'QC', cluster: 'HQ' },
    { key: 'uat', label: 'UAT', cluster: 'HQ' },
    { key: 'prd', label: 'PRD', cluster: 'HQ' },
    { key: 'prd_dr', label: 'PRD-DR', cluster: 'DR' },
  ],
  K8s: [
    { key: 'dev', label: 'DEV', cluster: 'HQ' },
    { key: 'qc', label: 'QC', cluster: 'HQ' },
    { key: 'uat', label: 'UAT', cluster: 'HQ' },
    { key: 'preprod', label: 'PREPROD', cluster: 'HQ' },
    { key: 'prd', label: 'PRD', cluster: 'HQ' },
    { key: 'prd_dr', label: 'PRD-DR', cluster: 'DR' },
  ],
}

/** A new project's project-level files are copied from this project's. */
export const PROJECT_TEMPLATE = 'GAFI_Digital_Network'

/** The old portal's APP_NAME_REGEX: letters, digits, `-`, `_` and `.`, starting with a letter or digit, at most 50. */
export const APPLICATION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,49}$/
export const APPLICATION_MAX = 50
