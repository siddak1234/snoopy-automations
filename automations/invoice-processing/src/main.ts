import { readManifests, serve } from '@autom8x/automation-sdk';

import { TEMPLATE_ID, define } from './automation.js';

// The manifest this container serves — v2 alone (`SERVED_VERSIONS`) — rides in the
// image under `manifests/`, copied by the Dockerfile from the repository's
// `manifests/`; MANIFESTS_DIR points elsewhere for a local run, and `define` keeps
// only the served versions of what it holds. None stops the container before it
// answers a probe.
const automation = define(readManifests(process.env.MANIFESTS_DIR ?? 'manifests', TEMPLATE_ID));

await serve({ templateId: automation.templateId, execute: automation.execute });
