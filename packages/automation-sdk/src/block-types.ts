/**
 * What a person reads of a run, as blocks (platform ADR-0048, Round 21, and its amendment 1, block
 * set v2; the run result's `blocks` in `automation-run-result.json`, its `$defs.emittedBlock`): a
 * success or a held result may send up to 60 of the twelve types an automation may send — text,
 * metric, badge, table, list, section, file, link, timeline, image, chart, group. Never
 * `questions` and never `open`, which are the platform's; a file and an image by its artifact id.
 * The platform keeps them with the run, draws them in the `result` part of the run's page in the
 * order sent (on an item run, as the item's reading), and refuses the result whole when one breaks
 * its rule — so `boundedBlocks` (`blocks.ts`, with the limits of `blocks-limits.ts`) holds them to
 * it first. A run's page is drawn from its blocks or from its `sections` and `details`, never both.
 * The shapes are the schema's, exactly; the platform's own are its
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
  'image',
  'chart',
  'group',
] as const;
/** A chart's two kinds (amendment 1, point 3). */
export const CHART_KINDS = ['bar', 'line'] as const;
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

export type ChartKind = (typeof CHART_KINDS)[number];
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

/**
 * A picture: one of the job's own files, by its artifact id, and its `alt`, read aloud only (1–200
 * characters, one line). No url: a block never names an outside image. The platform draws it
 * inline when the file is measured as the type it declares and at most 5 MiB, else as a file row.
 */
export interface EmittedImageBlock {
  readonly type: 'image';
  readonly fileId: string;
  readonly alt: string;
}

/** A chart's point: a finite `value` of at most 1e15 in size; `text`, when given, is shown for it. */
export interface ChartPoint {
  readonly label: string;
  readonly value: number;
  readonly text?: string;
}

/** A bar chart (1–24 points, none below 0) or a line (2–60 points), in the order sent. */
export interface EmittedChartBlock {
  readonly type: 'chart';
  readonly kind: ChartKind;
  readonly title: string;
  readonly points: readonly ChartPoint[];
}

export type EmittedLeaf =
  | TextBlock
  | MetricBlock
  | BadgeBlock
  | TableBlock
  | ListBlock
  | EmittedFileBlock
  | LinkBlock
  | TimelineBlock
  | EmittedImageBlock
  | EmittedChartBlock;

/** One level deep: never another section, and never a group. */
export interface SectionBlock {
  readonly type: 'section';
  readonly title: string;
  readonly subtitle?: string;
  readonly badge?: BlockBadge;
  readonly blocks: readonly EmittedLeaf[];
}

/**
 * A title over one card of drop-down sections (amendment 1, point 12): 1–12 sections, each held
 * as a top-level section is. Top level only: never inside a section, and never holding a group.
 */
export interface EmittedGroupBlock {
  readonly type: 'group';
  readonly title: string;
  readonly sections: readonly SectionBlock[];
}

/** What an automation may send: no questions, no `open`, files and images by artifact id. */
export type EmittedBlock = EmittedLeaf | SectionBlock | EmittedGroupBlock;
