/**
 * What a person reads of a run, as blocks (platform ADR-0048, Round 21; the run result's
 * `blocks` in `automation-run-result.json`, its `$defs.emittedBlock`): a success or a held result
 * may send up to 60 of the nine types an automation may send — text, metric, badge, table, list,
 * section, file, link, timeline. Never `questions` and never `open`, which are the platform's;
 * a file by its artifact id. The platform keeps them with the run, draws them in the `result`
 * part of the run's page in the order sent (on an item run, as the item's reading), and refuses
 * the result whole when one breaks its rule — so `boundedBlocks` (`blocks.ts`, with the limits)
 * holds them to it first. A run's page is drawn from its blocks or from its `sections` and
 * `details`, never both. The shapes are the schema's, exactly; the platform's own are its
 * `snoopy-backend/packages/contracts/src/blocks.ts`.
 */

export const EMITTED_BLOCK_TYPES = [
  'text',
  'metric',
  'badge',
  'table',
  'list',
  'section',
  'file',
  'link',
  'timeline',
] as const;
export const BLOCK_TONES = ['neutral', 'success', 'warning', 'error'] as const;
export const TEXT_STYLES = ['body', 'strong', 'muted', 'label'] as const;
export const TABLE_ALIGNS = ['start', 'end'] as const;
export const TIMELINE_STATES = [
  'waiting',
  'working',
  'done',
  'held',
  'failed',
  'skipped',
  'stopped',
  'unknown',
] as const;

export type BlockTone = (typeof BLOCK_TONES)[number];
export type TextStyle = (typeof TEXT_STYLES)[number];
export type TableAlign = (typeof TABLE_ALIGNS)[number];
export type TimelineState = (typeof TIMELINE_STATES)[number];

export interface BlockBadge {
  readonly text: string;
  readonly tone?: BlockTone;
}

/** 1–2,000 characters, line breaks kept. A `label` is a heading, drawn in capitals. */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly style?: TextStyle;
  readonly tone?: BlockTone;
}

export interface MetricBlock {
  readonly type: 'metric';
  readonly items: readonly {
    readonly label: string;
    readonly value: string;
    readonly tone?: BlockTone;
  }[];
}

export interface BadgeBlock extends BlockBadge {
  readonly type: 'badge';
}

export interface TableColumn {
  readonly title?: string;
  readonly align?: TableAlign;
  readonly muted?: boolean;
}

/** One cell per column; only the first must be non-empty. */
export interface TableRow {
  readonly cells: readonly string[];
  readonly note?: string;
  readonly strong?: boolean;
}

export interface TableBlock {
  readonly type: 'table';
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  readonly divided?: boolean;
}

/** A row: `lead` before the title (a rank), `value` after it (a score, read as `valueLabel`). */
export interface ListItem {
  readonly title: string;
  readonly subtitle?: string;
  readonly text?: string;
  /** `https:` only. */
  readonly url?: string;
  readonly badge?: BlockBadge;
  readonly lead?: string;
  readonly value?: string;
  readonly valueLabel?: string;
  readonly muted?: boolean;
}

/** `empty` is said when `items` is empty: "No candidates yet.". */
export interface ListBlock {
  readonly type: 'list';
  readonly items: readonly ListItem[];
  readonly empty?: string;
}

/** One of the job's own uploads, by the id its upload was given; the platform draws its row. */
export interface EmittedFileBlock {
  readonly type: 'file';
  readonly fileId: string;
  readonly title?: string;
}

export interface LinkBlock {
  readonly type: 'link';
  readonly title: string;
  readonly url: string;
}

export interface TimelineBlock {
  readonly type: 'timeline';
  readonly items: readonly {
    readonly title: string;
    readonly sub?: string;
    readonly state: TimelineState;
  }[];
}

export type EmittedLeaf =
  | TextBlock
  | MetricBlock
  | BadgeBlock
  | TableBlock
  | ListBlock
  | EmittedFileBlock
  | LinkBlock
  | TimelineBlock;

/** One level deep: never another section. */
export interface SectionBlock {
  readonly type: 'section';
  readonly title: string;
  readonly subtitle?: string;
  readonly badge?: BlockBadge;
  readonly blocks: readonly EmittedLeaf[];
}

/** What an automation may send: no questions, no `open`, files by artifact id. */
export type EmittedBlock = EmittedLeaf | SectionBlock;
