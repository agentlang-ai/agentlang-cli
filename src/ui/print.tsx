import React from 'react';
import { renderToString, Text, Box } from 'ink';

interface Part {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

function p(el: React.ReactElement): void {
  // eslint-disable-next-line no-console
  console.log(renderToString(el));
}

function pe(el: React.ReactElement): void {
  process.stderr.write(`${renderToString(el)}\n`);
}

export const ui = {
  // Bold green with ✔ prefix
  success: (msg: string) =>
    p(
      <Text bold color="green">
        {'✔  '}
        {msg}
      </Text>,
    ),

  // Red rounded border box with ✖ prefix — draws maximum attention
  error: (msg: string) =>
    pe(
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red">
          {'✖  '}
          {msg}
        </Text>
      </Box>,
    ),

  // Bold yellow with ⚠ prefix
  warn: (msg: string) =>
    p(
      <Text bold color="yellow">
        {'⚠  '}
        {msg}
      </Text>,
    ),

  // Cyan with › prefix — uses › instead of ℹ which breaks on many terminals
  info: (msg: string) =>
    p(
      <Text color="cyan">
        {'›  '}
        {msg}
      </Text>,
    ),

  cyan: (msg: string) => p(<Text color="cyan">{msg}</Text>),

  dim: (msg: string) => p(<Text dimColor>{msg}</Text>),

  plain: (msg: string) => p(<Text>{msg}</Text>),

  bold: (msg: string) => p(<Text bold>{msg}</Text>),

  magenta: (msg: string) => p(<Text color="magenta">{msg}</Text>),

  gray: (msg: string) => p(<Text color="gray">{msg}</Text>),

  // Startup banner — bold title with cyan underline
  banner: (title: string, subtitle?: string) =>
    p(
      <Box flexDirection="column">
        <Text>
          <Text bold color="white">
            {title}
          </Text>
          {subtitle !== undefined && subtitle !== '' && (
            <Text dimColor>
              {'  '}
              {subtitle}
            </Text>
          )}
        </Text>
        <Text color="cyan">{'─'.repeat(title.length + (subtitle ? subtitle.length + 2 : 0))}</Text>
      </Box>,
    ),

  // Aligned key-value label pair — for project/workspace/port display
  label: (key: string, value: string, valueColor?: string) =>
    p(
      <Box marginLeft={2}>
        <Box width={12}>
          <Text color="gray">{key}</Text>
        </Box>
        <Text color={valueColor ?? 'white'}>{value}</Text>
      </Box>,
    ),

  // Section title with a cyan underline separator
  header: (title: string) =>
    p(
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="white">
          {title}
        </Text>
        <Text color="cyan">{'─'.repeat(title.length)}</Text>
      </Box>,
    ),

  // Dim horizontal rule for visual separation
  divider: (width = 48) => p(<Text dimColor>{'─'.repeat(width)}</Text>),

  // Empty line
  // eslint-disable-next-line no-console
  blank: () => console.log(''),

  // Composite: "✓ label value" with bold green check + optional cyan value
  step: (check: string, label: string, value?: string) =>
    p(
      <Text>
        <Text bold color="green">
          {check}
        </Text>
        {label}
        {value !== undefined && <Text color="cyan">{value}</Text>}
      </Text>,
    ),

  // Multi-part row with mixed colors in a single line
  row: (parts: Part[]) =>
    p(
      <Text>
        {parts.map((part, i) => (
          <Text key={i} color={part.color} bold={part.bold} dimColor={part.dimColor}>
            {part.text}
          </Text>
        ))}
      </Text>,
    ),

  // Returns formatted ANSI strings (for spinner text, inline template use)
  format: {
    success: (msg: string) => renderToString(<Text color="green">{msg}</Text>),
    error: (msg: string) => renderToString(<Text color="red">{msg}</Text>),
    warn: (msg: string) => renderToString(<Text color="yellow">{msg}</Text>),
    info: (msg: string) => renderToString(<Text color="cyan">{msg}</Text>),
    cyan: (msg: string) => renderToString(<Text color="cyan">{msg}</Text>),
    dim: (msg: string) => renderToString(<Text dimColor>{msg}</Text>),
    gray: (msg: string) => renderToString(<Text color="gray">{msg}</Text>),
    bold: (msg: string) => renderToString(<Text bold>{msg}</Text>),
    boldWhite: (msg: string) =>
      renderToString(
        <Text bold color="white">
          {msg}
        </Text>,
      ),
    hex: (color: string) => (msg: string) => renderToString(<Text color={color}>{msg}</Text>),
    row: (parts: Part[]) =>
      renderToString(
        <Text>
          {parts.map((part, i) => (
            <Text key={i} color={part.color} bold={part.bold} dimColor={part.dimColor}>
              {part.text}
            </Text>
          ))}
        </Text>,
      ),
  },
};

// Raw ANSI for string contexts that require a plain string (readline prompts)
export const ansi = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
