import { readManifests, serve } from '@autom8x/automation-sdk';

import { SERVED_VERSIONS, TEMPLATE_ID, define } from './automation.js';

// The manifest this container serves — v5 alone (`SERVED_VERSIONS`) — rides in the image under
// `manifests/`, copied by the Dockerfile from the repository's `manifests/`; MANIFESTS_DIR points
// elsewhere for a local run. A directory holding none stops the container before it answers a probe.
const served = readManifests(process.env.MANIFESTS_DIR ?? 'manifests', TEMPLATE_ID).filter((m) =>
  SERVED_VERSIONS.includes(m.version),
);
const automation = define(served);

await serve({ templateId: automation.templateId, execute: automation.execute });
