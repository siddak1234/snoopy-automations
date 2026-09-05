import { serve } from '@autom8x/automation-sdk';

import { execute } from './run.js';

await serve({ templateId: 'invoice-intake', execute });
