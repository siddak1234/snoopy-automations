/**
 * What a flow's code may not reach for (CLAUDE.md rule 4; Round 21, D2.2 "Enforced"):
 * `fetch(`, Node's network modules, `undici`, a socket, and the vendor SDKs and HTTP clients a
 * flow might use. `test/network.test.ts` holds every flow and the template to it.
 */
const MODULES = [
  /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns)$/u,
  /^undici$/u,
  /^(?:axios|node-fetch|got|ky|superagent|cross-fetch|isomorphic-fetch)$/u,
  /^(?:openai|@anthropic-ai\/.+|@google\/.+|@google-cloud\/.+|googleapis|@aws-sdk\/.+|stripe|intuit-oauth|node-quickbooks|@slack\/.+|nodemailer)$/u,
];

/** Each line of `text` that reaches the network itself. */
export function networkProblems(text: string): string[] {
  const problems: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*(?:\/\/|\*)/u.test(line)) continue;
    if (/(?<![\w.])fetch\s*\(/u.test(line)) problems.push(`${index + 1}: fetch(`);
    if (/\bnew\s+(?:XMLHttpRequest|WebSocket)\b/u.test(line))
      problems.push(`${index + 1}: a socket`);
    for (const match of line.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gu,
    )) {
      if (MODULES.some((module) => module.test(match[2]!))) {
        problems.push(`${index + 1}: imports ${match[2]}`);
      }
    }
  }
  return problems;
}
