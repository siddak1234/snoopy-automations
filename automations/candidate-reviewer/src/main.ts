import { readManifests, serve } from '@autom8x/automation-sdk';

import { TEMPLATE_ID, define } from './automation.js';

// The manifest versions this container serves ride in the image under
// `manifests/`, copied by the Dockerfile from the repository's `manifests/`;
// MANIFESTS_DIR points elsewhere for a local run. A directory holding none stops
// the container before it answers a probe.
const automation = define(readManifests(process.env.MANIFESTS_DIR ?? 'manifests', TEMPLATE_ID));

await serve({ templateId: automation.templateId, execute: automation.execute });
