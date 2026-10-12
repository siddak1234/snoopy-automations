/**
 * `@autom8x/automation-kit/testing` — test doubles for an automation's suite: QuickBooks
 * behind the platform's Connections (`quickbooks-simulator.ts`), answering from a
 * made-up company (`quickbooks-company.ts`, with a sample of each record it holds) by
 * Intuit's documented query rules (`quickbooks-queries.ts`) and creates
 * (`quickbooks-writes.ts`).
 */
export {
  FAULT_MARKER,
  expenseLine,
  faultAnswer,
  sampleAccount,
  sampleBill,
  sampleCustomer,
  sampleEmployee,
  sampleJournalEntry,
  samplePurchase,
  sampleVendor,
} from './quickbooks-company.js';
export type { SimulatedCompany } from './quickbooks-company.js';
export { PROVIDER_REFUSALS, QuickBooksSimulator } from './quickbooks-simulator.js';
export type {
  QuickBooksSimulatorOptions,
  ScriptedAnswer,
  SimulatedCall,
} from './quickbooks-simulator.js';
