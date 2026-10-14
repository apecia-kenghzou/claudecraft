// Structured final output. Behaviour follows the bundle (EVIDENCE.md §20): the tool's input schema IS the caller-supplied
// JSON schema, it is read-only/concurrency-safe, and the model is told to call it exactly once at the end of its answer.
// The harness (src/harness.js) treats a successful call to this tool name as the end of the turn, surfacing its input as
// `structuredOutput` on the result instead of (or alongside) free text.
import { defineTool } from './harness.js';

export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';

export function createStructuredOutputTool({ schema }) {
  if (!schema || typeof schema !== 'object') throw new Error('createStructuredOutputTool needs a JSON schema object');
  return defineTool({
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: 'Return structured output in the requested format',
    inputSchema: schema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: (input) => JSON.stringify(input),
  });
}

export const STRUCTURED_OUTPUT_REMINDER = 'Use the StructuredOutput tool to return your final response in the requested '
  + 'structured format. You MUST call it exactly once, at the end of your response, to provide the structured output.';
